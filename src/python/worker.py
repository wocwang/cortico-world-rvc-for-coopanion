"""常驻 RVC 推理 worker。

由 `src/engine.ts` 启动：`python worker.py <codeDir> <voicesDir> <assetsDir>`。
`codeDir` 是包内的 `vendor/rvc`（只读），模型资产在 `assetsDir`（hubert_base/、rmvpe/）。
人声分离模型路径由环境变量 `RVC_UVR_MODEL` 给（空表示没装，分离相关请求直接报错）。
启动时载入 RVC 代码与默认音色、预热一次，然后按行读 stdin 的 JSON 请求、按行写 stdout 的 JSON 结果。

stdout 只放协议行（原 fd 被 dup 出来单独写，其余输出统统改到 stderr），
所以上游 RVC / i18n / torch 的 print 不会污染协议。

请求：
  {"op":"convert","id":1,"input":"a.wav","output":"b.wav","voice":"daifeiyu",
   "pitch":0,"indexRate":0.3,"protect":0.33,"format":"wav"}
  {"op":"separate","id":2,"input":"song.wav","output":"vocals.wav"}
  {"op":"cover","id":3,"input":"song.mp3","output":"cover.wav","voice":"daifeiyu",
   "pitch":0,"indexRate":0.3,"protect":0.33,"format":"wav","vocalGain":0,
   "sessionDir":"<dataDir>/sessions/20261109-221501-a1b2"}
  {"op":"remix","id":4,"vocals":"conv.wav","inst":"inst.wav","output":"mix.wav",
   "format":"wav","vocalGain":0,"instGain":0,"fadeIn":0,"fadeOut":0,"rmsRatio":1.0}
  {"op":"convertRange","id":5,"stem":"stems/vocals.wav","conv":"vocals/conv.wav",
   "startSec":32.0,"endSec":41.0,"contextSec":0.5,"seamSec":0.3,"outSr":44100,
   "voice":"daifeiyu","pitch":2,"indexRate":0.3,"protect":0.33,"inputPeak":0.91,
   "backupPath":"segments/s2.bak.wav"}
  {"op":"restoreRange","id":7,"conv":"vocals/conv.wav","backup":"segments/s2.bak.wav",
   "start":1764000,"end":2205000}  # start/end 是整数样本
  {"op":"peaks","id":6,"path":"vocals/conv.wav","buckets":1200}
  {"op":"master","id":8,"input":"out/mix-1.wav","output":"out/master-1.wav",
   "format":"wav","targetLufs":-14,"ceilingDb":-1}
  {"op":"shutdown"}

回复：
  {"type":"ready","device":"cuda:0","model":"daifeiyu","warn":null}
  {"type":"result","id":1,"ok":true,"ms":123,"sampleRate":40000}
  {"type":"result","id":3,"ok":true,"ms":12345,"sampleRate":44100,
   "stages":{"separate":6800,"convert":7200,"mix":40},"peakScale":0.87,
   "inputPeak":0.91,"rmsRatio":1.23,"durationSec":213.4}
  {"type":"result","id":1,"ok":false,"kind":"decode|infer|param","error":"..."}
  {"type":"fatal","error":"..."}
"""

import json
import os
import sys
import time
import traceback
from io import BytesIO
from pathlib import Path


def _is_foreign_tools(path: str, root: str) -> bool:
    """gpt-sovits 运行时根也在 sys.path 上，它那份 tools/ 会遮住本项目的 tools.cuda_graph。
    只看有没有 tools 目录，不依赖 tools/asr：运行时包缺 asr 时同样会遮住。"""
    try:
        return os.path.isdir(os.path.join(path, "tools")) and os.path.abspath(path) != root
    except OSError:
        return False


# ---------------------------------------------------------------------------
# 母带：ITU-R BS.1770-4 / EBU R128 响度 + 4 倍过采样真峰值 + 只削峰限幅
#
# 全部用运行时已有的 numpy / scipy，不引入新依赖。K 加权系数按 libebur128 的
# 公式从采样率推导（不写死 48 kHz 的那组），44.1 / 48 kHz 都适用。
# ---------------------------------------------------------------------------

LOUDNESS_PRESETS = (-14.0, -16.0, -23.0)


def _k_weighting(audio, sample_rate):
    """两级 K 加权（高架 + 38 Hz 高通），返回同形状 float64。"""
    import math

    import numpy as np
    from scipy.signal import lfilter

    # 第一级：高架（BS.1770 表格参数，按采样率重算双线性变换系数）
    f0 = 1681.974450955533
    gain_db = 3.999843853973347
    q = 0.7071752369554196
    k = math.tan(math.pi * f0 / sample_rate)
    vh = 10.0 ** (gain_db / 20.0)
    vb = vh ** 0.4996667741545416
    a0 = 1.0 + k / q + k * k
    b1 = np.array([(vh + vb * k / q + k * k) / a0, 2.0 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0])
    a1 = np.array([1.0, 2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0])

    # 第二级：高通
    f0 = 38.13547087602444
    q = 0.5003270373238773
    k = math.tan(math.pi * f0 / sample_rate)
    a0 = 1.0 + k / q + k * k
    b2 = np.array([1.0, -2.0, 1.0])
    a2 = np.array([1.0, 2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0])

    data = np.asarray(audio, dtype=np.float64)
    return lfilter(b2, a2, lfilter(b1, a1, data, axis=-1), axis=-1)


def _integrated_lufs(audio, sample_rate):
    """门限积分响度（LUFS）：400 ms 块、100 ms 步进、-70 LUFS 绝对门 + 相对 -10 LU 门。"""
    import numpy as np

    y = _k_weighting(audio, sample_rate)
    if y.ndim == 1:
        y = y.reshape(1, -1)
    blocks = max(1, int(round(0.4 * sample_rate)))
    hop = max(1, int(round(0.1 * sample_rate)))
    frames = int(y.shape[1])
    if frames <= 0:
        return float("-inf")
    if frames < blocks:
        power = np.mean(y * y, axis=1)
        total = float(power.sum())
        return -0.691 + 10.0 * np.log10(max(total, 1e-20))

    # 累加平方和，一次算出所有块，避免逐块切片。
    squares = np.cumsum(y * y, axis=1)
    squares = np.concatenate([np.zeros((y.shape[0], 1)), squares], axis=1)
    starts = np.arange(0, frames - blocks + 1, hop)
    means = (squares[:, starts + blocks] - squares[:, starts]) / blocks
    power = means.sum(axis=0)
    loudness = -0.691 + 10.0 * np.log10(np.maximum(power, 1e-20))

    absolute = loudness > -70.0
    if not absolute.any():
        return float("-inf")
    ungated = -0.691 + 10.0 * np.log10(max(float(power[absolute].mean()), 1e-20))
    relative = absolute & (loudness > ungated - 10.0)
    if not relative.any():
        relative = absolute
    return -0.691 + 10.0 * np.log10(max(float(power[relative].mean()), 1e-20))


def _true_peak_db(audio, sample_rate):
    """真峰值：每声道 4 倍过采样后再取绝对值峰值（dBTP）。

    直接拿原始采样点峰值当 true peak 会低估 0.3–1 dB，这里按 BS.1770 的建议
    先做 4 倍多相重采样，再取峰值。
    """
    import numpy as np
    from scipy.signal import resample_poly

    data = np.asarray(audio, dtype=np.float32)
    if data.ndim == 1:
        data = data.reshape(1, -1)
    peak = 0.0
    for channel in data:
        upsampled = resample_poly(channel, 4, 1)
        peak = max(peak, float(np.max(np.abs(upsampled))))
    return 20.0 * np.log10(max(peak, 1e-12))


def _peak_envelope(audio, sample_rate):
    """把 4 倍过采样峰值折回每个基础采样点，供限幅器使用。"""
    import numpy as np
    from scipy.signal import resample_poly

    data = np.asarray(audio, dtype=np.float32)
    if data.ndim == 1:
        data = data.reshape(1, -1)
    frames = int(data.shape[1])
    envelope = np.zeros(frames, dtype=np.float32)
    for channel in data:
        upsampled = np.abs(resample_poly(channel, 4, 1)).astype(np.float32)
        usable = (upsampled.size // 4) * 4
        folded = upsampled[:usable].reshape(-1, 4).max(axis=1)
        if folded.size < frames:
            folded = np.pad(folded, (0, frames - folded.size), mode="edge")
        envelope = np.maximum(envelope, folded[:frames])
    return envelope


def _limit_true_peak(audio, sample_rate, ceiling_db):
    """只压超过 ceiling 的峰：前视 3 ms + 汉宁平滑，返回 (处理后的音频, 最大衰减 dB)。"""
    import numpy as np
    from scipy.ndimage import minimum_filter1d

    data = np.asarray(audio, dtype=np.float32)
    if data.ndim == 1:
        data = data.reshape(1, -1)
    ceiling = 10.0 ** (ceiling_db / 20.0)
    envelope = _peak_envelope(data, sample_rate)
    gain = np.minimum(1.0, ceiling / np.maximum(envelope, 1e-9)).astype(np.float32)
    if float(gain.min()) >= 0.999999:
        return data, 0.0

    # 前视：让增益在峰值到达之前就降下来，避免削掉波头。
    lookahead = max(1, int(round(0.003 * sample_rate)))
    window = 2 * lookahead + 1
    # 对称滑窗最小值：提前与拖后各 3 ms，听感上比瞬时限幅干净。
    ahead = minimum_filter1d(gain, size=window, mode="nearest")
    smooth = np.hanning(window + 2)[1:-1].astype(np.float32)
    smooth /= smooth.sum()
    smooth_gain = np.convolve(ahead, smooth, mode="same").astype(np.float32)
    gain = np.minimum(np.clip(smooth_gain, 0.0, 1.0), 1.0)

    out = (data * gain[None, :]).astype(np.float32)
    # 平滑后再测一次；仍有残余过峰就整体收一点点（通常 < 0.1 dB）。
    peak = _true_peak_db(out, sample_rate)
    if peak > ceiling_db:
        out *= 10.0 ** ((ceiling_db - peak) / 20.0)
    return out, float(-20.0 * np.log10(max(float(gain.min()), 1e-9)))


def master_audio(audio, sample_rate, target_lufs, ceiling_db=-1.0):
    """把音频做响度归一化并限幅；返回 (处理后音频, 各项实测值)。"""
    import numpy as np

    data = np.asarray(audio, dtype=np.float32)
    if data.ndim == 1:
        data = data.reshape(1, -1)
    input_lufs = _integrated_lufs(data, sample_rate)
    input_peak = _true_peak_db(data, sample_rate)
    if not np.isfinite(input_lufs):
        raise ValueError("音频是静音或太轻，量不到响度")

    gain_db = float(target_lufs) - input_lufs
    out = (data * (10.0 ** (gain_db / 20.0))).astype(np.float32)
    limited_db = 0.0
    # 限幅会把响度拉下来一点；最多回头补 3 次增益，再补就只是在压峰。
    for _ in range(4):
        out, current = _limit_true_peak(out, sample_rate, ceiling_db)
        limited_db = max(limited_db, current)
        measured = _integrated_lufs(out, sample_rate)
        delta = float(target_lufs) - measured
        if abs(delta) <= 0.1:
            break
        out = (out * (10.0 ** (delta / 20.0))).astype(np.float32)
    out, current = _limit_true_peak(out, sample_rate, ceiling_db)
    limited_db = max(limited_db, current)
    output_lufs = _integrated_lufs(out, sample_rate)
    output_peak = _true_peak_db(out, sample_rate)
    return out, {
        "targetLufs": round(float(target_lufs), 2),
        "ceilingDb": round(float(ceiling_db), 2),
        "inputLufs": round(float(input_lufs), 2),
        "inputTruePeakDb": round(float(input_peak), 2),
        "outputLufs": round(float(output_lufs), 2),
        "outputTruePeakDb": round(float(output_peak), 2),
        "gainDb": round(float(gain_db), 2),
        "limitedDb": round(float(limited_db), 2),
    }


def _last_line(text, limit: int = 300) -> str:
    """只留上游状态文本的最后一行。

    `vc_single` 失败时给的是「【单次推理】/ 状态: 失败 / …」这样的多行日志，
    整段塞进面板既看不清重点，也会把无关的运行记录一起暴露出来。
    """
    lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]
    return (lines[-1] if lines else str(text or "推理失败"))[:limit]


def _env_switch(name: str, default: str = "1") -> bool:
    return (os.environ.get(name) or default).strip().lower() not in ("0", "off", "false", "no")


# 高音补救：模型在超出音域的段会整段掉八度（或唱到别的音），此时「降到音域内重唱、
# 再用保共振峰的方式升回去」能保住音高正确。质量不如直接唱，但比整句错调/尖叫好。
HIGH_RESCUE = _env_switch("RVC_HIGH_RESCUE")
RESCUE_FLOOR = float(os.environ.get("RVC_HIGH_RESCUE_FLOOR") or 800.0)
RESCUE_ERR_ST = float(os.environ.get("RVC_HIGH_RESCUE_ERR") or 3.0)
RESCUE_MIN_BAD = float(os.environ.get("RVC_HIGH_RESCUE_MIN") or 0.15)
RESCUE_STEPS = max(1, int(float(os.environ.get("RVC_HIGH_RESCUE_STEPS") or 3)))


def _pitch_curve(samples, sample_rate):
    """10 ms 网格的 F0 曲线（Hz，0 表示清音）；上限放到 2400 以覆盖宽音域音色。"""
    import numpy as np
    import parselmouth

    data = np.asarray(samples, dtype=np.float64)
    if data.ndim > 1:
        data = data.mean(axis=1)
    if data.size < int(0.05 * sample_rate):
        return np.zeros(0, dtype=np.float32)
    pitch = parselmouth.Sound(data, sampling_frequency=float(sample_rate)).to_pitch_ac(
        time_step=0.01, voicing_threshold=0.6, pitch_floor=75.0, pitch_ceiling=2400.0
    )
    return np.asarray(pitch.selected_array["frequency"], dtype=np.float32)


def _high_error_ratio(src_f0, out_f0, pitch: int):
    """高音段里「输出音高错得离谱」的帧占比；错得离谱 = 差 3 个半音以上（含整八度）。"""
    import numpy as np

    count = min(int(src_f0.size), int(out_f0.size))
    if count < 40:
        return 0.0, 0
    expected = src_f0[:count].astype(np.float32) * float(2.0 ** (float(pitch) / 12.0))
    got = out_f0[:count]
    mask = (expected >= RESCUE_FLOOR) & (src_f0[:count] > 0) & (got > 0)
    total = int(mask.sum())
    if total < 40:
        return 0.0, total
    ratio = np.maximum(got[mask] / np.maximum(expected[mask], 1e-6), 1e-6)
    steps = np.abs(12.0 * np.log2(ratio))
    return float((steps >= RESCUE_ERR_ST).mean()), total


def _align_latency(shifted, reference, sample_rate, max_ms: float = 120.0):
    """补偿移调器引入的整体延迟（rubberband 会把输出整体推后十几毫秒）。

    用短时能量包络做互相关找延迟——包络对音高变化不敏感，定得准；
    找不到可信峰值就原样返回，绝不把音频越裁越糟。
    """
    import numpy as np

    n = min(np.asarray(shifted).size, np.asarray(reference).size)
    if n < int(0.2 * sample_rate):
        return shifted
    hop = max(1, int(0.005 * sample_rate))
    win = max(1, int(0.010 * sample_rate))
    count = (n - win) // hop
    if count < 8:
        return shifted

    def envelope(samples):
        data = np.asarray(samples, dtype=np.float32)[: n]
        frames = np.lib.stride_tricks.sliding_window_view(data, win)[::hop][:count]
        return np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))

    try:
        a = envelope(reference)
        b = envelope(shifted)
    except Exception:
        return shifted
    a = a - a.mean()
    b = b - b.mean()
    if not np.any(a) or not np.any(b):
        return shifted
    size = 1
    while size < 2 * count:
        size *= 2
    corr = np.fft.irfft(np.fft.rfft(b, size) * np.conj(np.fft.rfft(a, size)), size)[:count]
    limit = max(1, int(max_ms / 5.0))
    lags = np.concatenate((corr[-limit:], corr[:limit]))
    offsets = np.concatenate((np.arange(-limit, 0), np.arange(0, limit)))
    best = int(offsets[int(np.argmax(lags))]) * hop
    peak = float(lags.max() / (np.std(a) * np.std(b) * count + 1e-9))
    if abs(best) < hop or peak < 0.15:
        return shifted
    data = np.asarray(shifted, dtype=np.float32)
    if best > 0:
        out = data[best:]
    else:
        out = np.pad(data, (-best, 0))
    if out.size < np.asarray(reference).size:
        out = np.pad(out, (0, np.asarray(reference).size - out.size))
    return out[: np.asarray(reference).size]


def _shift_pitch_formant(samples, sample_rate, semitones: float):
    """升 semitones 半音并保持共振峰（ffmpeg rubberband），走管道不落临时文件。"""
    import shutil
    import subprocess

    import numpy as np

    exe = shutil.which("ffmpeg")
    if not exe:
        print("[rvc] 高音补救跳过：PATH 里没有 ffmpeg", file=sys.stderr)
        return None
    rate = float(2.0 ** (float(semitones) / 12.0))
    wave = np.asarray(samples, dtype=np.float32)
    if wave.ndim > 1:
        wave = wave.mean(axis=1)
    wave = np.ascontiguousarray(wave.reshape(-1), dtype="<f4")
    if wave.size < 16:
        return None
    proc = subprocess.run(
        [exe, "-hide_banner", "-loglevel", "error",
         "-f", "f32le", "-ar", str(int(sample_rate)), "-ac", "1", "-i", "pipe:0",
         "-af", "rubberband=pitch=%.6f:formant=preserved" % rate,
         "-f", "f32le", "-ar", str(int(sample_rate)), "-ac", "1", "pipe:1"],
        input=wave.tobytes(), capture_output=True,
    )
    if proc.returncode != 0 or not proc.stdout:
        tail = _last_line(proc.stderr.decode("utf-8", "replace")) if proc.stderr else "returncode %s" % proc.returncode
        print("[rvc] 高音补救跳过：ffmpeg rubberband 不可用（%s）" % tail, file=sys.stderr)
        return None
    out = np.frombuffer(proc.stdout, dtype="<f4").astype(np.float32, copy=True)
    if out.size < 16:
        return None
    return out, int(sample_rate)
def _release_memory() -> None:
    """把本轮推理释放的堆还给系统。

    Windows 上 Python/CRT 的堆不会因为引用归零就收缩；反复整首重跑会把提交内存
    越推越高，最后连 30 MB 的 numpy 分配都会失败（_ArrayMemoryError）。
    """
    try:
        import gc

        gc.collect()
    except Exception:
        pass
    if os.name == "nt":
        try:
            import ctypes

            ctypes.CDLL("msvcrt")._heapmin()
        except Exception:
            pass


def main() -> int:
    if len(sys.argv) < 4:
        print("usage: worker.py <codeDir> <voicesDir> <assetsDir>", file=sys.stderr)
        return 2
    root = os.path.abspath(sys.argv[1])
    voices = os.path.abspath(sys.argv[2])
    assets = os.path.abspath(sys.argv[3])

    # 协议通道：先复制一份原 stdout，再把 fd 1 指向 stderr。
    proto = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    os.dup2(2, 1)

    def emit(obj) -> None:
        proto.write(json.dumps(obj, ensure_ascii=False) + "\n")
        proto.flush()

    if not os.path.isdir(root):
        emit({"type": "fatal", "error": "推理代码目录不存在：%s" % root})
        return 1
    # 资产缺失就在 import torch 之前报出来：引擎能立刻报错，不必等到 3 分钟超时。
    missing = [
        os.path.join(assets, "hubert_base", "config.json"),
        os.path.join(assets, "hubert_base", "pytorch_model.bin"),
        os.path.join(assets, "rmvpe", "rmvpe.pt"),
    ]
    absent = [p for p in missing if not os.path.isfile(p)]
    if absent:
        emit({"type": "fatal", "error": "缺少模型资产：%s（在面板里安装，或把 assets 目录指到已有权重）" % "、".join(absent)})
        return 1
    os.makedirs(voices, exist_ok=True)
    os.makedirs(assets, exist_ok=True)

    sys.path[:] = [p for p in sys.path if not (p and _is_foreign_tools(p, root))]
    # 包内代码（melband）与 worker.py 同目录。共享运行时可能以隔离模式启动，
    # 脚本目录不一定在 sys.path 上；显式补一次，别让高质量分离白白回退。
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    # 人声分离的移植代码在包内 `vendor/uvr`（与 `vendor/rvc` 同级），只读。
    uvr_dir = os.path.join(os.path.dirname(root), "uvr")
    if os.path.isdir(uvr_dir):
        sys.path.insert(0, uvr_dir)
    sys.path.insert(0, root)
    os.chdir(root)

    os.environ["weight_root"] = voices
    os.environ["index_root"] = voices
    os.environ["outside_index_root"] = voices
    os.environ["rmvpe_root"] = os.path.join(assets, "rmvpe")
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    # numba 把编译缓存放在源码旁的 __pycache__，启动时用 tempfile 探测目录可写性。
    # Windows 上这个探测在受保护目录（共享运行时的 site-packages）里会按 TMP_MAX 次反复重试，
    # 实测把启动卡死数分钟。目录本身可写，跳过探测，直接建目录。
    try:
        import numba.core.caching as _numba_caching

        def _ensure_cache_path(self) -> None:
            os.makedirs(self.get_cache_path(), exist_ok=True)

        _numba_caching._CacheLocator.ensure_cache_path = _ensure_cache_path
    except Exception:
        pass

    started = time.time()
    from configs.config import Config  # noqa: E402  (先修好 sys.path 再 import)

    saved_argv, sys.argv = sys.argv, [sys.argv[0]]
    try:
        config = Config()
    finally:
        sys.argv = saved_argv

    from infer.audio import load_audio, wav2  # noqa: E402
    from infer.vc.modules import VC  # noqa: E402
    from infer import hubert as _hubert  # noqa: E402
    # 上游把 hubert 目录写死在代码根下；资产放在插件数据目录，这里改指过去（模块读的是这个全局量）。
    _hubert.HUBERT_MODEL_PATH = Path(assets, "hubert_base").resolve()

    vc = VC(config)
    current = {"voice": "", "index": ""}

    # f0 跟踪器（分箱映射在三条路径上完全一致）：
    #   sw2   = 默认。SwiftF0 打底（公开基准精度最高、八度错最少），再用 pm 做八度守卫
    #   swift = 纯 SwiftF0（最快、最省 cpu，无 pm 守卫）
    #   hy2   = 旧默认：rmvpe 打底、只在高音区用 pm 修八度上跳
    #   pm    = 纯 Praat 自相关（高音准，但低音/气声段容易乱跳、把音量打空）
    #   rmvpe = 上游旧默认（中低音稳，900 Hz 以上容易掉八度；也用来做“完全旧行为”回退）
    # 覆盖方式：环境变量 RVC_F0_METHOD=<上面任意一个>
    f0_method = (os.environ.get("RVC_F0_METHOD") or "sw2").strip().lower()
    if f0_method not in ("pm", "rmvpe", "hy2", "swift", "sw2"):
        f0_method = "sw2"
    print("[rvc] f0 跟踪器：%s" % f0_method, file=sys.stderr)

    def voice_path(name: str) -> str:
        base = name if name.lower().endswith(".pth") else name + ".pth"
        return os.path.join(voices, base)

    def write_bin_meta(base: str) -> None:
        """把权重的音高分箱（256/360 bin 与上限 Hz）写到 sidecar，供面板标注。"""
        try:
            meta = {
                "voice": base,
                "f0Bin": int(getattr(vc, "f0_bin", 256)),
                "f0Max": float(getattr(vc, "f0_max", 1100.0)),
            }
            with open(
                os.path.join(voices, base + ".binmeta.json"), "w", encoding="utf-8"
            ) as fh:
                json.dump(meta, fh, ensure_ascii=False, indent=1)
        except Exception as error:  # noqa: BLE001 - 标注失败不影响转换
            print("[rvc] 写分箱信息失败：%s" % error, file=sys.stderr)

    def load_voice(name: str) -> None:
        """换音色（含同名 .index）；同名音色不重复载入。"""
        name = (name or "").strip()
        if not name:
            raise LookupError("没有指定音色")
        path = voice_path(name)
        if not os.path.isfile(path):
            raise LookupError("音色不存在：%s" % path)
        base = os.path.splitext(os.path.basename(path))[0]
        if current["voice"] == base:
            return
        vc.get_vc(os.path.basename(path))
        index = os.path.join(voices, base + ".index")
        current["voice"] = base
        current["index"] = index if os.path.isfile(index) else ""
        print(
            "[rvc] 已载入音色 %s（index: %s，%d bin / %.0f Hz）"
            % (base, current["index"] or "无", vc.f0_bin, vc.f0_max),
            file=sys.stderr,
        )
        write_bin_meta(base)

    default_voice = (os.environ.get("RVC_DEFAULT_VOICE") or "").strip()
    if not default_voice:
        candidates = sorted(n for n in os.listdir(voices) if n.lower().endswith(".pth"))
        default_voice = os.path.splitext(candidates[0])[0] if candidates else ""
    warn = None
    if default_voice:
        try:
            load_voice(default_voice)
        except Exception as error:
            warn = "默认音色载入失败：%s" % error
            print("[rvc] %s" % warn, file=sys.stderr)
    else:
        warn = "音色目录里没有 .pth"
        print("[rvc] %s" % warn, file=sys.stderr)

    # 预热一次（RMVPE 初始化 / CUDA graph 捕获都在首次推理里，约 17 秒）。用一段低音量正弦。
    if current["voice"]:
        try:
            import numpy as np
            import soundfile as sf

            sr = 16000
            t = np.arange(sr * 2, dtype=np.float32) / sr
            # 每个 worker 用独立临时目录：两个 worker 同时启动时不要抢同一个预热文件。
            import shutil
            import tempfile

            warm_dir = tempfile.mkdtemp(prefix="rvc-warmup-")
            warm = os.path.join(warm_dir, "warmup.wav")
            sf.write(warm, (0.1 * np.sin(2 * np.pi * 220.0 * t)).astype(np.float32), sr)
            status, result = vc.vc_single(0, warm, 0, f0_method, current["index"], 0.3, 0, 1.0, 0.33)
            if not result or result[1] is None:
                warn = "预热失败（仍按就绪处理）：%s" % str(status).splitlines()[-1][:200]
                print("[rvc] %s" % warn, file=sys.stderr)
            shutil.rmtree(warm_dir, ignore_errors=True)
        except Exception as error:
            warn = "预热异常（仍按就绪处理）：%s" % error
            print("[rvc] %s\n%s" % (warn, traceback.format_exc()), file=sys.stderr)

    emit({
        "type": "ready",
        "device": getattr(config, "device", None),
        "model": current["voice"] or None,
        "warn": warn,
        "loadMs": int((time.time() - started) * 1000),
    })

    # LAME 只认这几档采样率；RVC v2 出的是 40 kHz，直接编码会在 avcodec_open2 报 EINVAL。
    MP3_RATES = (8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000)

    def write_audio(path: str, audio, sample_rate: int, output_format: str) -> None:
        import numpy as np
        import soundfile as sf

        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        if output_format in ("wav", "flac"):
            sf.write(path, audio, sample_rate)
            return
        if output_format == "mp3" and sample_rate not in MP3_RATES:
            from math import gcd

            from scipy.signal import resample_poly

            # run_vc 给的是 int16 波形，重采样前先归一化；否则 sf.write 会把 ±3 万的值削成全幅方波。
            data = np.asarray(audio)
            data = data.astype(np.float32) / 32768.0 if np.issubdtype(data.dtype, np.integer) else data.astype(np.float32)
            target = min(MP3_RATES, key=lambda rate: abs(rate - sample_rate))
            step = gcd(target, sample_rate)
            audio = resample_poly(data, target // step, sample_rate // step, axis=0)
            sample_rate = target
        with BytesIO() as wav_file:
            sf.write(wav_file, audio, sample_rate, format="wav")
            wav_file.seek(0)
            with open(path, "wb") as out:
                wav2(wav_file, out, output_format)

    uvr_model = (os.environ.get("RVC_UVR_MODEL") or "").strip()
    separation = {"model": None, "high": None, "highPath": ""}
    # 长音频切片：整段一次性喂给 HuBERT，显卡紧张时会 CUDA OOM（实测 2 分钟人声 + gpt-sovits 共存）。
    CHUNK_SECONDS = 20.0
    OVERLAP_SECONDS = 0.3

    def run_vc(path: str, pitch: int, index_rate: float, protect: float, chunked: bool = True, _rescue: bool = True):
        """整段或分段跑 RVC，返回 (sampleRate, int16 波形)。

        分段时按**绝对时间轴**摆放每一片：每片输出先裁/补到它应有的长度，再叠进总缓冲，
        接缝处用互补权重交叉淡入淡出。这样每片的长度误差不会累积，不会出现「唱到后面人声比伴奏慢」。
        每片还按它相对全局的峰值补回音量（RVC 会把每片输出峰值归一化到 0.99，不补会忽大忽小）。
        """
        import numpy as np
        import soundfile as sf

        audio = load_audio(path, 16000)
        chunk = int(CHUNK_SECONDS * 16000)
        if not chunked or len(audio) <= chunk:
            # vc_single 返回 (状态文本, (采样率, 波形))。直接透传会让调用方把状态文本
            # 当成采样率（`int("【单次推理】…")` → ValueError），短于 20 秒必现；
            # 变声（convert）与翻唱（cover）都走这里，改的时候两条路径一起看。
            status, result = vc.vc_single(0, path, pitch, f0_method, current["index"], index_rate, 0, 1.0, protect)
            if not result or result[0] is None or result[1] is None:
                return status, None
            if _rescue:
                result = _maybe_rescue(path, result, pitch, index_rate, protect, chunked)
            return result

        overlap = int(OVERLAP_SECONDS * 16000)
        global_peak = float(np.abs(audio).max()) or 1.0
        pieces = []
        total_chunks = len(range(0, len(audio), chunk))
        tmp = path + ".part.wav"
        try:
            index = 0
            for start in range(0, len(audio), chunk):
                index += 1
                # 还没到最后一片时多带一段尾巴，供拼接时交叉淡入淡出。
                tail = overlap if start + chunk < len(audio) else 0
                end = min(len(audio), start + chunk + tail)
                segment = audio[start:end]
                sf.write(tmp, segment, 16000, subtype="FLOAT")
                print("[rvc] 切片 %d/%d：%.1f 秒" % (index, total_chunks, len(segment) / 16000.0), file=sys.stderr)
                status, result = vc.vc_single(0, tmp, pitch, f0_method, current["index"], index_rate, 0, 1.0, protect)
                if not result or result[0] is None or result[1] is None:
                    return status, None
                sample_rate = int(result[0])
                piece = np.asarray(result[1]).astype(np.float32) / 32768.0
                peak = float(np.abs(segment).max()) or 1.0
                piece *= min(1.0, peak / global_peak)
                pieces.append((start, end, piece, sample_rate))
                try:
                    import torch

                    if str(getattr(config, "device", "")) != "cpu":
                        torch.cuda.empty_cache()
                except Exception:
                    pass
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
        if not pieces:
            return "没有可转换的音频", None

        # 绝对时间轴拼装：总长 = 输入时长 × 输出采样率，避免逐片拼接把误差累加成延迟。
        sample_rate = pieces[0][3]
        total_out = int(round(len(audio) / 16000.0 * sample_rate))
        mixed = np.zeros(total_out, dtype=np.float32)
        weight = np.zeros(total_out, dtype=np.float32)
        ov = max(1, int(OVERLAP_SECONDS * sample_rate))
        for start, end, piece, _sr in pieces:
            at = int(round(start / 16000.0 * sample_rate))
            expected = int(round((end - start) / 16000.0 * sample_rate))
            if len(piece) >= expected:
                piece = piece[:expected]
            else:
                piece = np.pad(piece, (0, expected - len(piece)))
            ramp = np.ones(expected, dtype=np.float32)
            if start > 0:
                k = min(ov, expected)
                ramp[:k] = np.linspace(0.0, 1.0, k, dtype=np.float32)
            if end < len(audio):
                k = min(ov, expected)
                ramp[-k:] = np.linspace(1.0, 0.0, k, dtype=np.float32)
            stop = min(total_out, at + expected)
            span = stop - at
            if span <= 0:
                continue
            mixed[at:stop] += piece[:span] * ramp[:span]
            weight[at:stop] += ramp[:span]
        mixed /= np.maximum(weight, 1e-3)
        output = (sample_rate, (np.clip(mixed, -1.0, 1.0) * 32767).astype(np.int16))
        if _rescue:
            output = _maybe_rescue(path, output, pitch, index_rate, protect, chunked)
        return output

    def _maybe_rescue(path, result, pitch, index_rate, protect, chunked):
        """高音段整段唱错（掉八度/跑到别的音）时，降几半音重唱再保共振峰升回去。

        只在「高音帧里错音比例超过阈值」时触发，重唱后必须确实变好才采用；
        否则原样返回，任何异常都吞掉——这是补救，不该把整次转换搞失败。
        """
        if not HIGH_RESCUE:
            return result
        try:
            import numpy as np

            sample_rate = int(result[0])
            raw = np.asarray(result[1])
            scale = 32768.0 if raw.dtype.kind in "iu" else 1.0
            original = raw.astype(np.float32) / scale
            if original.ndim > 1:
                original = original.mean(axis=1)
            if original.size < sample_rate:
                return result
            # 干声按 44.1 kHz 解码再测 F0：16 kHz 下 parselmouth 在 1 kHz 以上会掉八度、
            # 清浊判断也偏，测出来的错音比例不可信；44.1 kHz 与输出同一个 10 ms 网格。
            src_mono = load_audio(path, 44100)
            src_rate = 44100
            _src_curve = _pitch_curve(src_mono, src_rate)
            _out_curve = _pitch_curve(original, sample_rate)
            bad, total = _high_error_ratio(_src_curve, _out_curve, pitch)
            if total < 40:
                return result
            print("[rvc] 高音检查：%d 个高音帧，错音 %.1f%%" % (total, bad * 100.0), file=sys.stderr)
            if bad < RESCUE_MIN_BAD:
                return result
            lower = pitch - RESCUE_STEPS
            if lower < -24:
                return result
            alt = run_vc(path, lower, index_rate, protect, chunked, _rescue=False)
            if alt is None or alt[0] is None or alt[1] is None:
                print(
                    "[rvc] 高音补救：降 %d 半音重唱失败，保留原输出（%s）"
                    % (RESCUE_STEPS, _last_line(alt[0] if alt else "无结果")),
                    file=sys.stderr,
                )
                return result
            alt_rate = int(alt[0])
            alt_raw = np.asarray(alt[1])
            alt_scale = 32768.0 if alt_raw.dtype.kind in "iu" else 1.0
            lower_wave = alt_raw.astype(np.float32) / alt_scale
            if lower_wave.ndim > 1:
                lower_wave = lower_wave.mean(axis=1)
            shifted = _shift_pitch_formant(lower_wave, alt_rate, RESCUE_STEPS)
            if shifted is None:
                return result
            up, up_rate = shifted
            if up.ndim > 1:
                up = up.mean(axis=1)
            up = _align_latency(up, lower_wave, up_rate)
            fixed = up[: original.size] if up.size >= original.size else np.pad(up, (0, original.size - up.size))
            bad_after, total_after = _high_error_ratio(
                _pitch_curve(src_mono, src_rate), _pitch_curve(fixed, up_rate), pitch
            )
            if total_after >= 40 and bad_after < bad - 0.05:
                print(
                    "[rvc] 高音补救生效：错音 %.1f%% → %.1f%%（降 %d 半音重唱后升回）"
                    % (bad * 100.0, bad_after * 100.0, RESCUE_STEPS),
                    file=sys.stderr,
                )
                return (up_rate, (np.clip(fixed, -1.0, 1.0) * 32767).astype(np.int16))
            print(
                "[rvc] 高音补救无效：错音 %.1f%% → %.1f%%，保留原输出"
                % (bad * 100.0, bad_after * 100.0),
                file=sys.stderr,
            )
        except Exception as error:
            if _env_switch("RVC_RESCUE_DEBUG", "0"):
                print("[rvc] 高音补救异常：%s" % traceback.format_exc(), file=sys.stderr)
            else:
                print("[rvc] 高音补救跳过：%s" % error, file=sys.stderr)
        return result


    def encode(req: dict) -> None:
        """把已有的 WAV 成品转成 MP3（面板「以 MP3 保存」用）。"""
        req_id = req.get("id")
        src = req.get("input") or ""
        dst = req.get("output") or ""
        fmt = (req.get("format") or "mp3").lower()
        if fmt != "mp3":
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": "只支持转成 MP3"})
            return
        if not src or not os.path.isfile(src):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "读不到音频：%s" % src})
            return
        if not dst:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": "缺少输出路径"})
            return
        began = time.time()
        try:
            os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
            if src.lower().endswith((".wav", ".wave")):
                with open(src, "rb") as source, open(dst, "wb") as sink:
                    wav2(source, sink, fmt)
            else:
                import soundfile as sf

                data, sr = sf.read(src, always_2d=True, dtype="float32")
                write_audio(dst, data, sr, fmt)
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": traceback.format_exc()[-800:]})
            return
        emit({
            "type": "result", "id": req_id, "ok": True,
            "ms": int((time.time() - began) * 1000), "bytes": os.path.getsize(dst),
        })

    def get_separator():
        """按需载入分离模型（63 MB，ONNX）；没装就把原因抛给面板。"""
        if separation["model"] is not None:
            return separation["model"]
        if not uvr_model or not os.path.isfile(uvr_model):
            raise LookupError("人声分离模型未安装：%s（在服务页点「一键安装」补上，约 64 MB）" % (uvr_model or "(未配置路径)"))
        # 派生 venv 的 site-packages 排在共享运行时后面，不提到最前就会用到底座那份 CPU 版 onnxruntime。
        try:
            import sysconfig

            purelib = sysconfig.get_paths().get("purelib")
            if purelib and purelib not in sys.path:
                sys.path.insert(0, purelib)
        except Exception:
            pass
        from mdx import MdxSeparator

        separation["model"] = MdxSeparator(uvr_model)
        print("[rvc] 人声分离模型已载入 %s（%s）" % (uvr_model, getattr(separation["model"], "provider", "CPU")), file=sys.stderr)
        return separation["model"]

    def get_high_separator(model_path):
        """高质量档：Mel-Band RoFormer（CUDAGPU）；失败由调用方回退默认档。"""
        if separation["high"] is not None and separation["highPath"] == model_path:
            return separation["high"]
        if not model_path or not os.path.isfile(model_path):
            raise RuntimeError("高质量分离权重未下载：%s" % (model_path or "(未配置路径)"))
        from melband import MelBandSeparator

        separation["high"] = MelBandSeparator(model_path)
        separation["highPath"] = model_path
        print("[rvc] 高质量分离模型已载入 %s（%s）" % (model_path, separation["high"].provider), file=sys.stderr)
        return separation["high"]

    def load_song(path: str):
        """整首歌解码成 44.1 kHz 立体声 float32（分离模型固定用这个采样率）。

        不用 `librosa.load`：这个运行时里它会在打开文件后卡住（实测无输出、单核空转），
        改用 RVC 自己的 ffmpeg 解码（`_decode_audio_ffmpeg` 保留原采样率与声道），
        再用 scipy 重采样——两条路径都不依赖 numba。
        """
        import numpy as np

        from infer.audio import _decode_audio_ffmpeg, _load_audio_ffmpeg
        from math import gcd

        from scipy.signal import resample_poly

        try:
            mix, sr = _decode_audio_ffmpeg(path)
        except Exception:
            # ffmpeg 判不出声道之类：退回单声道 44.1 kHz，至少能跑。
            mix, sr = _load_audio_ffmpeg(path, 44100, force_mono=True).reshape(1, -1), 44100
        if int(sr) != 44100:
            g = gcd(int(sr), 44100)
            mix = resample_poly(mix, 44100 // g, int(sr) // g, axis=1).astype(np.float32)
        if mix.shape[0] == 1:
            mix = np.repeat(mix, 2, axis=0)
        elif mix.shape[0] > 2:
            mix = mix[:2]
        return np.ascontiguousarray(mix, dtype=np.float32)

    def resample_to_44100(audio, sample_rate: int):
        """把 RVC 输出的 40 kHz（或别的）音频重采样到 44.1 kHz。"""
        import numpy as np

        from math import gcd

        from scipy.signal import resample_poly

        if int(sample_rate) == 44100:
            return audio.astype(np.float32, copy=False)
        g = gcd(int(sample_rate), 44100)
        return resample_poly(audio, 44100 // g, int(sample_rate) // g, axis=-1).astype(np.float32)

    # 静音门：RVC 会把分离残留、气口、尾音放大成嘶声，所以按「同一份干声」的 RMS 包络生成
    # 掩码，把本来就没人的段压成数字静音。阈值取 max(-55 dBFS, 有声段 99 分位 - 45 dB)，
    # 掩码扩边 80 ms（不切断起音）、40 ms 平滑（不出咔哒）。默认开；要原样输出设
    # RVC_SILENCE_GATE=0。
    GATE_ENABLED = (os.environ.get("RVC_SILENCE_GATE") or "1").strip().lower() not in ("0", "off", "false", "no")

    def gate_mask(src, src_sr, out_len, out_sr, floor_db=-55.0, rel_db=45.0,
                  hop_ms=10.0, expand_ms=80.0, fade_ms=40.0):
        """按干声 RMS 包络生成 0..1 掩码：有声≈1，静音/残留≈0，长度对齐到输出采样率。"""
        import numpy as np

        hop = max(1, int(round(src_sr * hop_ms / 1000.0)))
        src = np.asarray(src, dtype=np.float32).reshape(-1)
        n_frames = max(1, int(np.ceil(src.size / float(hop))))
        padded = np.zeros(n_frames * hop, dtype=np.float32)
        padded[: src.size] = np.abs(src[: n_frames * hop])
        rms = np.sqrt(np.mean(padded.reshape(n_frames, hop) ** 2, axis=1) + 1e-12)
        db = 20.0 * np.log10(rms + 1e-9)
        loud = db[db > -70.0]
        ref = float(np.percentile(loud, 99)) if loud.size else -20.0
        threshold = max(float(floor_db), ref - float(rel_db))
        mask = (db > threshold).astype(np.float32)
        grow = int(round(expand_ms / hop_ms))
        if grow > 0:
            grown = mask.copy()
            for i in range(1, grow + 1):
                grown[i:] = np.maximum(grown[i:], mask[:-i])
                grown[:-i] = np.maximum(grown[:-i], mask[i:])
            mask = grown
        fade = int(round(fade_ms / hop_ms))
        if fade > 1:
            window = np.hanning(fade + 2)[1:-1].astype(np.float32)
            mask = np.convolve(mask, window / window.sum(), mode="same")
        centre = (np.arange(n_frames, dtype=np.float64) + 0.5) * hop / float(src_sr)
        ticks = np.arange(max(1, int(out_len)), dtype=np.float64) / float(out_sr)
        return np.interp(ticks, centre, mask).astype(np.float32)

    def gate_vocal(conv, src, src_sr, conv_sr):
        """静音门后处理：conv 是 RVC 输出（int16 或 float），src 是同一段干声。"""
        import numpy as np

        if not GATE_ENABLED:
            return conv
        try:
            data = np.asarray(conv)
            integer = np.issubdtype(data.dtype, np.integer)
            scale = 32768.0 if integer else 1.0
            data = data.astype(np.float32) / scale
            mask = gate_mask(src, src_sr, data.size, conv_sr)
            gated = data * mask
            if integer:
                return (np.clip(gated, -1.0, 1.0) * 32767.0).astype(np.int16)
            return gated
        except Exception as error:
            print("[rvc] 静音门跳过：%s" % error, file=sys.stderr)
            return conv

    # 气声保护：模型遇到气声/轻声（干声几乎没有谐波结构）时会自己「编」一段低频嗡鸣，音量还比
    # 干声高 15–25 dB，听感像被压低喉咙唱出来。这里按「干声谐噪比低 + 输出明显比干声更响」反推
    # 这些帧，把干声原样混回去（20 ms 交叉淡化）。正常演唱段几乎不动（实测整曲 4.5% 帧）。
    # 默认开；要原样输出设 RVC_BREATH_GUARD=0。阈值可用 RVC_BREATH_HNR / RVC_BREATH_OVER_DB 调。
    BREATH_ENABLED = (os.environ.get("RVC_BREATH_GUARD") or "1").strip().lower() not in ("0", "off", "false", "no")
    BREATH_HNR_MAX = float(os.environ.get("RVC_BREATH_HNR") or 6.0)
    BREATH_OVER_DB = float(os.environ.get("RVC_BREATH_OVER_DB") or 6.0)

    def breath_weights(src, src_sr, conv, conv_sr, hop_ms=10.0, hnr_max=None, over_db=None,
                       floor_db=-50.0, min_run_ms=50.0, fade_ms=20.0):
        """返回「该用干声」的权重曲线（0..1，采样点对齐到 conv）；算不出来返回 None。"""
        import numpy as np

        try:
            import parselmouth
        except Exception:
            return None
        hnr_max = BREATH_HNR_MAX if hnr_max is None else float(hnr_max)
        over_db = BREATH_OVER_DB if over_db is None else float(over_db)
        src = np.asarray(src, dtype=np.float32).reshape(-1)
        conv = np.asarray(conv, dtype=np.float32).reshape(-1)
        if src.size < int(src_sr * 0.05) or conv.size < 2:
            return None
        # 干声逐帧 RMS
        hop = max(1, int(round(src_sr * hop_ms / 1000.0)))
        n_frames = max(1, int(np.ceil(src.size / float(hop))))
        padded = np.zeros(n_frames * hop, dtype=np.float32)
        padded[: src.size] = src[: n_frames * hop]
        src_rms = np.sqrt(np.mean(padded.reshape(n_frames, hop) ** 2, axis=1) + 1e-12)
        src_db = 20.0 * np.log10(src_rms + 1e-9)
        # 输出逐帧 RMS（按时间对齐到干声帧）
        ratio = float(conv_sr) / float(src_sr)
        conv_hop = max(1, int(round(hop * ratio)))
        n_conv = max(1, int(np.ceil(conv.size / float(conv_hop))))
        cp = np.zeros(n_conv * conv_hop, dtype=np.float32)
        cp[: conv.size] = conv[: n_conv * conv_hop]
        conv_rms = np.sqrt(np.mean(cp.reshape(n_conv, conv_hop) ** 2, axis=1) + 1e-12)
        conv_db_full = 20.0 * np.log10(conv_rms + 1e-9)
        src_ticks = (np.arange(n_frames, dtype=np.float64) + 0.5) * hop / float(src_sr)
        conv_ticks = (np.arange(n_conv, dtype=np.float64) + 0.5) * conv_hop / float(conv_sr)
        conv_db = np.interp(src_ticks, conv_ticks, conv_db_full)
        # 干声谐噪比（parselmouth，10 ms 帧；无声/无周期帧会给 -200 之类的低值）
        try:
            sound = parselmouth.Sound(np.asarray(src, dtype=np.float64), sampling_frequency=int(src_sr))
            harms = sound.to_harmonicity_cc(time_step=hop_ms / 1000.0, minimum_pitch=70.0, silence_threshold=0.03)
            hnr = np.asarray(harms.values[0], dtype=np.float64)
        except Exception:
            return None
        hnr = np.pad(hnr, (0, max(0, n_frames - hnr.size)), mode="edge")[:n_frames]
        mask = (hnr < hnr_max) & (src_db > float(floor_db)) & ((conv_db - src_db) > over_db)
        # 只保留 >= min_run_ms 的连续段（避免把单个清辅音全换掉），两端各外扩 2 帧
        keep = np.zeros(n_frames, dtype=bool)
        min_run = max(1, int(round(min_run_ms / hop_ms)))
        edges = np.flatnonzero(np.diff(np.r_[0, mask.astype(np.int8), 0]))
        for start, end in zip(edges[::2], edges[1::2]):
            if end - start >= min_run:
                keep[max(0, start - 2): min(n_frames, end + 2)] = True
        fade = max(1, int(round(fade_ms / hop_ms)))
        window = np.hanning(fade + 2)[1:-1] if fade > 2 else np.array([1.0])
        weights = np.convolve(keep.astype(np.float64), window / window.sum(), mode="same") if window.sum() > 0 else keep.astype(np.float64)
        out_ticks = np.arange(conv.size, dtype=np.float64) / float(conv_sr)
        return np.interp(out_ticks, src_ticks, weights).astype(np.float32)

    def breath_guard(conv, src, src_sr, conv_sr):
        """气声保护后处理：conv 是 RVC 输出（int16 或 float），src 是同一段干声。"""
        import numpy as np

        if not BREATH_ENABLED:
            return conv
        try:
            data = np.asarray(conv)
            integer = np.issubdtype(data.dtype, np.integer)
            scale = 32768.0 if integer else 1.0
            data = data.astype(np.float32) / scale
            weights = breath_weights(src, src_sr, data, conv_sr)
            if weights is None:
                return conv
            from math import gcd
            from scipy.signal import resample_poly

            dry = np.asarray(src, dtype=np.float32).reshape(-1)
            if int(src_sr) != int(conv_sr):
                g = gcd(int(src_sr), int(conv_sr))
                dry = resample_poly(dry, int(conv_sr) // g, int(src_sr) // g).astype(np.float32)
            mixed = data.copy()
            n = min(mixed.size, dry.size)
            if n > 0:
                mixed[:n] = data[:n] * (1.0 - weights[:n]) + dry[:n] * weights[:n]
            if integer:
                return (np.clip(mixed, -1.0, 1.0) * 32767.0).astype(np.int16)
            return mixed
        except Exception as error:
            print("[rvc] 气声保护跳过：%s" % error, file=sys.stderr)
            return conv

    # 高音幻觉保护：干声里根本没有高音内容时，模型偶尔会凭空「唱」出一个高八度的音
    # （1300–1600 Hz、谐噪比只有 2–4 dB 的噪声帧），听感像突然尖叫或整句移调。这里把干声与
    # 输出的 f0 都测出来，凡是输出比「干声 × 变调比」高出 ratio（默认 1.35 倍 ≈ 5.2 个半音）、
    # 并且本身高于 floor（默认 800 Hz）的帧，就把该帧换回干声（与气声保护同一套混合机制）。
    # 默认开；要原样输出设 RVC_HIGH_GUARD=0。阈值可用 RVC_HIGH_RATIO / RVC_HIGH_FLOOR 调。
    HIGH_ENABLED = (os.environ.get("RVC_HIGH_GUARD") or "1").strip().lower() not in ("0", "off", "false", "no")
    HIGH_RATIO = float(os.environ.get("RVC_HIGH_RATIO") or 1.35)
    HIGH_FLOOR_HZ = float(os.environ.get("RVC_HIGH_FLOOR") or 800.0)
    HIGH_HNR_MAX = float(os.environ.get("RVC_HIGH_HNR") or 10.0)

    def _f0_curve(sig, sr, hop_ms=10.0, floor=60.0, ceiling=2400.0, voicing=0.5):
        """parselmouth AC 逐帧 f0；无声帧为 0。算不出来返回 None。"""
        import numpy as np

        try:
            import parselmouth
        except Exception:
            return None
        sig = np.asarray(sig, dtype=np.float32).reshape(-1)
        if sig.size < int(sr * 0.05):
            return None
        try:
            sound = parselmouth.Sound(sig.astype(np.float64), sampling_frequency=int(sr))
            pitch = sound.to_pitch_ac(
                time_step=hop_ms / 1000.0,
                pitch_floor=float(floor),
                pitch_ceiling=float(ceiling),
                voicing_threshold=float(voicing),
            )
        except Exception:
            return None
        return np.asarray(pitch.selected_array["frequency"], dtype=np.float64)

    def high_weights(src, src_sr, conv, conv_sr, pitch=0, hop_ms=10.0, ratio=None,
                     floor_hz=None, floor_db=-45.0, min_run_ms=30.0, fade_ms=10.0, hnr_max=None):
        """返回「输出音高明显高于干声、该换回干声」的权重曲线（0..1，对齐到 conv）；算不出来返回 None。"""
        import numpy as np

        ratio = HIGH_RATIO if ratio is None else float(ratio)
        floor_hz = HIGH_FLOOR_HZ if floor_hz is None else float(floor_hz)
        src = np.asarray(src, dtype=np.float32).reshape(-1)
        conv = np.asarray(conv, dtype=np.float32).reshape(-1)
        if src.size < int(src_sr * 0.05) or conv.size < 2:
            return None
        f_dry = _f0_curve(src, src_sr, hop_ms=hop_ms)
        f_out = _f0_curve(conv, conv_sr, hop_ms=hop_ms)
        if f_dry is None or f_out is None or f_dry.size == 0 or f_out.size == 0:
            return None
        # 干声逐帧电平（换回去的帧必须是有内容的，纯静音交给静音门）
        hop = max(1, int(round(src_sr * hop_ms / 1000.0)))
        n_frames = max(1, int(np.ceil(src.size / float(hop))))
        padded = np.zeros(n_frames * hop, dtype=np.float32)
        padded[: src.size] = src[: n_frames * hop]
        src_rms = np.sqrt(np.mean(padded.reshape(n_frames, hop) ** 2, axis=1) + 1e-12)
        src_db = 20.0 * np.log10(src_rms + 1e-9)
        src_ticks = (np.arange(n_frames, dtype=np.float64) + 0.5) * hop / float(src_sr)
        out_ticks = (np.arange(f_out.size, dtype=np.float64) + 0.5) * hop / float(conv_sr)
        f_dry_on_src = np.pad(f_dry, (0, max(0, n_frames - f_dry.size)), mode="edge")[:n_frames]
        f_out_on_src = np.interp(src_ticks, out_ticks, f_out)
        expect = pow(2.0, float(pitch) / 12.0)
        with np.errstate(divide="ignore", invalid="ignore"):
            jump = (f_out_on_src > 0.0) & (f_dry_on_src > 0.0)
            over = np.where(jump, (f_out_on_src / np.maximum(f_dry_on_src * expect, 1e-6)), 0.0)
        # 两种都算「凭空多出来的高音」：干声有音高但输出远超它，或干声根本没音高（气声/清辅音）而输出在唱高音。
        mask = (f_out_on_src > floor_hz) & (src_db > float(floor_db)) & (
            (jump & (over > ratio)) | (~jump))
        # 只保留 >= min_run_ms 的连续段，两端各外扩 2 帧，再做 10 ms 淡化；段太长（>0.4 s）不当幻觉，
        # 那通常是真高音，留着不动。另外只认可「输出本身也是噪声」的段（默认 HNR < 10 dB）——
        # 干净的高音即使比干声高也不该被换掉。
        hnr_max = HIGH_HNR_MAX if hnr_max is None else float(hnr_max)
        keep = np.zeros(n_frames, dtype=bool)
        min_run = max(1, int(round(min_run_ms / hop_ms)))
        max_run = max(min_run, int(round(0.4 / hop_ms)))
        edges = np.flatnonzero(np.diff(np.r_[0, mask.astype(np.int8), 0]))
        try:
            import parselmouth
        except Exception:
            parselmouth = None
        for start, end in zip(edges[::2], edges[1::2]):
            if end - start < min_run or end - start > max_run:
                continue
            if parselmouth is not None:
                t0 = max(0, start - 3)
                t1 = min(n_frames, end + 3)
                sr_ratio = float(conv_sr) / float(src_sr)
                a = int(t0 * hop * sr_ratio)
                b = min(conv.size, int(t1 * hop * sr_ratio))
                if b - a < int(conv_sr * 0.02):
                    continue
                try:
                    snip = parselmouth.Sound(conv[a:b].astype(np.float64), sampling_frequency=int(conv_sr))
                    hv = np.asarray(snip.to_harmonicity_cc(time_step=hop_ms / 1000.0, minimum_pitch=70.0,
                                                         silence_threshold=0.03).values[0], dtype=np.float64)
                    hv = hv[np.isfinite(hv)]
                    if hv.size and float(np.median(hv)) >= hnr_max:
                        continue
                except Exception:
                    pass
            keep[max(0, start - 2): min(n_frames, end + 2)] = True
        fade = max(1, int(round(fade_ms / hop_ms)))
        window = np.hanning(fade + 2)[1:-1] if fade > 2 else np.array([1.0])
        weights = np.convolve(keep.astype(np.float64), window / window.sum(), mode="same") if window.sum() > 0 else keep.astype(np.float64)
        ticks = np.arange(conv.size, dtype=np.float64) / float(conv_sr)
        return np.interp(ticks, src_ticks, weights).astype(np.float32)

    def high_guard(conv, src, src_sr, conv_sr, pitch=0):
        """高音幻觉保护后处理：conv 是 RVC 输出（int16 或 float），src 是同一段干声。"""
        import numpy as np

        if not HIGH_ENABLED:
            return conv
        try:
            data = np.asarray(conv)
            integer = np.issubdtype(data.dtype, np.integer)
            scale = 32768.0 if integer else 1.0
            data = data.astype(np.float32) / scale
            weights = high_weights(src, src_sr, data, conv_sr, pitch=pitch)
            if weights is None:
                return conv
            from math import gcd
            from scipy.signal import resample_poly

            dry = np.asarray(src, dtype=np.float32).reshape(-1)
            if int(src_sr) != int(conv_sr):
                g = gcd(int(src_sr), int(conv_sr))
                dry = resample_poly(dry, int(conv_sr) // g, int(src_sr) // g).astype(np.float32)
            mixed = data.copy()
            n = min(mixed.size, dry.size)
            if n > 0:
                mixed[:n] = data[:n] * (1.0 - weights[:n]) + dry[:n] * weights[:n]
            if integer:
                return (np.clip(mixed, -1.0, 1.0) * 32767.0).astype(np.int16)
            return mixed
        except Exception as error:
            print("[rvc] 高音保护跳过：%s" % error, file=sys.stderr)
            return conv

    def convert(req: dict) -> None:
        req_id = req.get("id")
        target = (req.get("voice") or "").strip() or default_voice
        fmt = (req.get("format") or "wav").lower()
        if fmt not in ("wav", "mp3"):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": "未知的输出格式：%s" % fmt})
            return
        try:
            load_voice(target)
        except Exception as error:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": str(error)})
            return
        source = req.get("input") or ""
        if not source or not os.path.isfile(source):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "读不到输入音频：%s" % source})
            return
        try:
            src_mono = load_audio(source, 16000)  # 先单独解码一次，解码失败按 400 报，不算推理失败
        except Exception as error:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "解码失败：%s" % error})
            return
        began = time.time()
        try:
            result = run_vc(
                source,
                int(req.get("pitch") or 0),
                float(req.get("indexRate", 0.3)),
                float(req.get("protect", 0.33)),
                bool(req.get("chunk", 1)),
            )
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": traceback.format_exc()[-1500:]})
            return
        if not result or result[0] is None or result[1] is None:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": _last_line(result[0] if result else "没有可转换的音频")})
            return
        # 高音幻觉保护：输出音高明显高于干声的帧换回干声；气声保护把低频嗡鸣换回干声；最后静音门。
        result = (result[0], high_guard(result[1], src_mono, 16000, int(result[0]), pitch=int(req.get("pitch") or 0)))
        result = (result[0], breath_guard(result[1], src_mono, 16000, int(result[0])))
        result = (result[0], gate_vocal(result[1], src_mono, 16000, int(result[0])))
        try:
            write_audio(req.get("output") or "", result[1], int(result[0]), fmt)
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": "写出失败：%s" % traceback.format_exc()[-800:]})
            return
        emit({"type": "result", "id": req_id, "ok": True, "ms": int((time.time() - began) * 1000), "sampleRate": int(result[0])})

    def separate(req: dict) -> None:
        """只分离，不变声：给 `POST /convert?separator=uvr5` 与自检用。"""
        req_id = req.get("id")
        source = req.get("input") or ""
        if not source or not os.path.isfile(source):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "读不到输入音频：%s" % source})
            return
        try:
            sep = get_separator()
        except LookupError as error:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": str(error)})
            return
        try:
            mix = load_song(source)
        except Exception as error:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "解码失败：%s" % error})
            return
        began = time.time()
        try:
            vocals, instrumental = sep.separate(mix)
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": traceback.format_exc()[-1500:]})
            return
        try:
            import soundfile as sf

            # 分离出来的 float 波形可能超过 ±1，写 PCM_16 会削波；FLOAT wav 原样保留，RVC 用 ffmpeg 读得动。
            os.makedirs(os.path.dirname(os.path.abspath(req.get("output") or "")), exist_ok=True)
            sf.write(req.get("output") or "", vocals.T, 44100, subtype="FLOAT")
            inst_path = req.get("instrumental") or ""
            if inst_path:
                os.makedirs(os.path.dirname(os.path.abspath(inst_path)), exist_ok=True)
                sf.write(inst_path, instrumental.T, 44100, subtype="FLOAT")
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": "写出失败：%s" % traceback.format_exc()[-800:]})
            return
        emit({"type": "result", "id": req_id, "ok": True, "ms": int((time.time() - began) * 1000), "sampleRate": 44100})

    def cover(req: dict) -> None:
        """整首歌：分离人声/伴奏 → 人声变声 → 混回整首。"""
        import numpy as np

        req_id = req.get("id")
        target = (req.get("voice") or "").strip() or default_voice
        fmt = (req.get("format") or "wav").lower()
        if fmt not in ("wav", "mp3"):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": "未知的输出格式：%s" % fmt})
            return
        try:
            load_voice(target)
        except Exception as error:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": str(error)})
            return
        source = req.get("input") or ""
        if not source or not os.path.isfile(source):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "读不到输入音频：%s" % source})
            return
        note = ""
        tier = (req.get("sepModel") or "fast").strip().lower()
        sep = None
        used_high = False
        if tier == "high":
            try:
                sep = get_high_separator((req.get("melbandModel") or "").strip())
                used_high = True
            except Exception as error:
                note = str(error)[:200]
                print("[rvc] 高质量分离不可用，已回退默认档：%s" % note, file=sys.stderr)
        if sep is None:
            try:
                sep = get_separator()
            except LookupError as error:
                emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": str(error)})
                return
        try:
            mix = load_song(source)
        except Exception as error:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "解码失败：%s" % error})
            return

        began = time.time()
        try:
            vocals, instrumental = sep.separate(mix)
        except Exception as error:
            if used_high:
                # 显存不够 / 推理失败：先放掉高频档模型，换回默认档，不让整首翻唱失败。
                note = str(error)[:200]
                print("[rvc] 高质量分离失败，已回退默认档：%s" % note, file=sys.stderr)
                separation["high"] = None
                separation["highPath"] = ""
                sep = None
                try:
                    import torch

                    torch.cuda.empty_cache()
                except Exception:
                    pass
                try:
                    sep = get_separator()
                    vocals, instrumental = sep.separate(mix)
                    used_high = False
                except Exception:
                    emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": "分离失败：%s" % traceback.format_exc()[-1500:]})
                    return
            else:
                emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": "分离失败：%s" % traceback.format_exc()[-1500:]})
                return
        separate_ms = int((time.time() - began) * 1000)
        if used_high:
            # 分离完成后立刻把 Mel-Band 放掉：后面 RVC 变声要显存，常驻 1 GB 会把
            # CUDA Graph / 长音频变声挤到 OOM；下次用再载入（实测约 5 秒）。
            separation["high"] = None
            separation["highPath"] = ""
            sep = None
            try:
                import torch

                torch.cuda.empty_cache()
            except Exception:
                pass

        stem_dir = (req.get("sessionDir") or "").strip()
        if stem_dir:
            # 会话模式：分轨落在 session 里，任务结束也不删。
            vocal_path = os.path.join(stem_dir, "stems", "vocals.wav")
            inst_path = os.path.join(stem_dir, "stems", "inst.wav")
        else:
            vocal_path = source + ".vocals.wav"
            inst_path = ""
        try:
            import soundfile as sf

            os.makedirs(os.path.dirname(os.path.abspath(vocal_path)), exist_ok=True)
            sf.write(vocal_path, vocals.T, 44100, subtype="FLOAT")
            if inst_path:
                os.makedirs(os.path.dirname(os.path.abspath(inst_path)), exist_ok=True)
                sf.write(inst_path, instrumental.T, 44100, subtype="FLOAT")
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": "写出人声失败：%s" % traceback.format_exc()[-800:]})
            return

        convert_began = time.time()
        try:
            result = run_vc(
                vocal_path,
                int(req.get("pitch") or 0),
                float(req.get("indexRate", 0.3)),
                float(req.get("protect", 0.33)),
                bool(req.get("chunk", 1)),
            )
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": traceback.format_exc()[-1500:]})
            return
        finally:
            if not stem_dir:
                try:
                    os.remove(vocal_path)
                except OSError:
                    pass
        if not result or result[0] is None or result[1] is None:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": _last_line(result[0] if result else "没有可转换的音频")})
            return
        convert_ms = int((time.time() - convert_began) * 1000)

        # 会话模式额外记两个数：后续区间重跑复现音量、重混沿用同一电平比例。
        input_peak = 0.0
        if stem_dir:
            try:
                input_peak = float(np.abs(load_audio(vocal_path, 16000)).max())
            except Exception:
                input_peak = float(np.abs(vocals).max())

        try:
            conv_sr, conv = int(result[0]), np.asarray(result[1])
            if conv.ndim > 1:
                conv = conv.mean(axis=1)
            # RVC 回的是 int16（已归一到约 0.99 峰值）；换成 float 才能和人声/伴奏相加。
            conv = conv.astype(np.float32) / 32768.0 if conv.dtype.kind in "iu" else conv.astype(np.float32)
            conv = resample_to_44100(conv, conv_sr)
            n = instrumental.shape[1]
            conv = conv[:n] if conv.size >= n else np.pad(conv, (0, n - conv.size))
            # 电平比例按「未门控」的 RMS 算，否则静音被压掉会让整首歌人声变大。
            conv = high_guard(conv, vocals.mean(axis=0), 44100, 44100, pitch=int(req.get("pitch") or 0))
            conv = breath_guard(conv, vocals.mean(axis=0), 44100, 44100)
            rms_conv_raw = float(np.sqrt(np.mean(conv.astype(np.float64) ** 2)))
            conv = gate_vocal(conv, vocals.mean(axis=0), 44100, 44100)
            if stem_dir:
                conv_path = os.path.join(stem_dir, "vocals", "conv.wav")
                os.makedirs(os.path.dirname(os.path.abspath(conv_path)), exist_ok=True)
                sf.write(conv_path, conv, 44100, subtype="FLOAT")
            # 电平对齐：RVC 输出被峰值归一化过，直接叠会盖过伴奏；按原人声的 RMS 比例把音量拉回来。
            rms_vocal = float(np.sqrt(np.mean(vocals ** 2)))
            rms_conv = rms_conv_raw
            ratio = 1.0 if rms_vocal < 1e-5 or rms_conv < 1e-5 else min(4.0, max(0.25, rms_vocal / rms_conv))
            gain = ratio * (10 ** (float(req.get("vocalGain") or 0) / 20.0))
            with_bgm = bool(req.get("withBgm", True))
            if with_bgm:
                out = instrumental + np.tile(conv, (2, 1)) * gain
                peak = float(np.abs(out).max())
                scale = 1.0
                if peak > 0.99:
                    scale = 0.99 / peak
                    out *= scale
                write_audio(req.get("output") or "", out.T, 44100, fmt)
            else:
                # 清唱：只保留人声，但用与翻唱版相同的 rmsRatio / vocalGain 和峰值保护。
                clean = conv * gain
                peak = float(np.abs(clean).max())
                scale = 1.0
                if peak > 0.99:
                    scale = 0.99 / peak
                    clean *= scale
                clean_path = req.get("output") or ""
                write_audio(clean_path, clean.T, 44100, fmt)
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": "混音失败：%s" % traceback.format_exc()[-800:]})
            return
        emit({
            "type": "result",
            "id": req_id,
            "ok": True,
            "ms": int((time.time() - began) * 1000),
            "sampleRate": 44100,
            "stages": {"separate": separate_ms, "convert": convert_ms,
                       "mix": int((time.time() - began) * 1000) - separate_ms - convert_ms},
            "peakScale": round(scale, 3),
            "inputPeak": round(input_peak, 4),
            "modelSampleRate": int(conv_sr),
            "rmsRatio": round(ratio, 4),
            "withBgm": with_bgm,
            "durationSec": round(n / 44100.0, 3),
            "separator": "mel_band" if used_high else "mdx",
            "separatorNote": note,
        })

    def reconvert(req: dict) -> None:
        """复用已分离的人声分轨重跑整首变声，原地替换 conv.wav（不改伴奏、不重做分离）。

        与 cover 的区别：跳过 UVR 分离。旧 conv 先备份成 `conv.bak.wav`，新结果写到临时文件
        再原子替换；模型输出长度与旧成品差太多就中止，绝不静默产生错位的混音。
        """
        import shutil

        import numpy as np
        import soundfile as sf

        req_id = req.get("id")
        voice_name = (req.get("voice") or "").strip() or default_voice
        stem = req.get("stem") or ""
        inst = req.get("inst") or ""
        conv_path = req.get("conv") or ""
        if not stem or not os.path.isfile(stem):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "读不到人声分轨：%s" % stem})
            return
        if not inst or not os.path.isfile(inst):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "读不到伴奏分轨：%s" % inst})
            return
        if not conv_path or not os.path.isfile(conv_path):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "旧变声结果不存在，无法原地重跑：%s" % conv_path})
            return
        try:
            load_voice(voice_name)
        except Exception as error:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": str(error)})
            return

        try:
            inst_frames = int(sf.info(inst).frames)
            old_frames = int(sf.info(conv_path).frames)
        except Exception as error:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "读不到会话音频信息：%s" % error})
            return
        if inst_frames <= 0:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": "伴奏是空文件"})
            return
        # 旧 conv 应当与伴奏等长（cover 写盘前已对齐）；对不上说明会话本身已经错位。
        if abs(old_frames - inst_frames) > int(0.05 * 44100):
            emit({
                "type": "result", "id": req_id, "ok": False, "kind": "param",
                "error": "旧成品与分轨时长不一致（%.3f 秒 vs %.3f 秒），已中止，未覆盖原成品"
                         % (old_frames / 44100.0, inst_frames / 44100.0),
            })
            return
        expected = float(req.get("expectedSec") or 0)
        if expected > 0 and abs(inst_frames / 44100.0 - expected) > 0.05:
            emit({
                "type": "result", "id": req_id, "ok": False, "kind": "param",
                "error": "分轨时长（%.3f 秒）与原始记录（%.3f 秒）不一致，已中止，未覆盖原成品"
                         % (inst_frames / 44100.0, expected),
            })
            return

        began = time.time()
        try:
            result = run_vc(
                stem,
                int(req.get("pitch") or 0),
                float(req.get("indexRate", 0.3)),
                float(req.get("protect", 0.33)),
                bool(req.get("chunk", 1)),
            )
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": traceback.format_exc()[-1500:]})
            return
        if not result or result[0] is None or result[1] is None:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": _last_line(result[0] if result else "没有可转换的音频")})
            return

        conv_sr, conv = int(result[0]), np.asarray(result[1])
        if conv.ndim > 1:
            conv = conv.mean(axis=1)
        conv = conv.astype(np.float32) / 32768.0 if conv.dtype.kind in "iu" else conv.astype(np.float32)
        conv = resample_to_44100(conv, conv_sr)
        if abs(conv.size - inst_frames) > int(0.2 * 44100):
            emit({
                "type": "result", "id": req_id, "ok": False, "kind": "param",
                "error": "重跑时长（%.3f 秒）与旧成品（%.3f 秒）不一致，已中止，未覆盖原成品"
                         % (conv.size / 44100.0, inst_frames / 44100.0),
            })
            return
        conv = conv[:inst_frames] if conv.size >= inst_frames else np.pad(conv, (0, inst_frames - conv.size))
        _rms_raw = float(np.sqrt(np.mean(conv.astype(np.float64) ** 2)))
        try:
            _stem, _ = sf.read(stem, dtype="float32", always_2d=False)
            if getattr(_stem, "ndim", 1) > 1:
                _stem = _stem.mean(axis=1)
            _stem_f = np.asarray(_stem, dtype=np.float32)
            conv = high_guard(conv, _stem_f, 44100, 44100, pitch=int(req.get("pitch") or 0))
            conv = breath_guard(conv, _stem_f, 44100, 44100)
            conv = gate_vocal(conv, _stem_f, 44100, 44100)
        except Exception:
            pass

        backup_path = (req.get("backup") or "").strip() or os.path.join(os.path.dirname(os.path.abspath(conv_path)), "conv.bak.wav")
        tmp_path = conv_path + ".new.wav"
        try:
            os.makedirs(os.path.dirname(os.path.abspath(conv_path)), exist_ok=True)
            shutil.copyfile(conv_path, backup_path)
            sf.write(tmp_path, conv, 44100, subtype="FLOAT")
            os.replace(tmp_path, conv_path)
        except Exception:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": "写回变声结果失败：%s" % traceback.format_exc()[-800:]})
            return

        try:
            vocal, _ = sf.read(stem, dtype="float32", always_2d=False)
            if getattr(vocal, "ndim", 1) > 1:
                vocal = vocal.mean(axis=1)
            rms_vocal = float(np.sqrt(np.mean(np.asarray(vocal, dtype=np.float64) ** 2)))
            rms_conv = _rms_raw
            ratio = 1.0 if rms_vocal < 1e-5 or rms_conv < 1e-5 else min(4.0, max(0.25, rms_vocal / rms_conv))
        except Exception:
            ratio = 1.0

        emit({
            "type": "result",
            "id": req_id,
            "ok": True,
            "ms": int((time.time() - began) * 1000),
            "sampleRate": 44100,
            "modelSampleRate": conv_sr,
            "durationSec": round(inst_frames / 44100.0, 3),
            "rmsRatio": round(ratio, 4),
            "backupPath": backup_path,
        })

    def remix(req: dict) -> None:
        """只重做混音：读已分离的伴奏与变声后人声，按增益/淡入淡出混成一条。

        不重新分离、不变声；分块流式读写，长音频也不会整首进内存。
        电平比例（rmsRatio）由首次翻唱算好后冻结传入，避免局部重跑后整首忽大忽小。
        """
        import numpy as np
        import soundfile as sf

        req_id = req.get("id")
        fmt = (req.get("format") or "wav").lower()
        if fmt not in ("wav", "mp3"):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": "未知的输出格式：%s" % fmt})
            return
        vocals = req.get("vocals") or ""
        inst = req.get("inst") or ""
        output = req.get("output") or ""
        if not output:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": "缺少输出路径"})
            return
        for path in (vocals, inst):
            if not path or not os.path.isfile(path):
                emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "读不到音频：%s" % path})
                return

        began = time.time()
        try:
            ratio = float(req.get("rmsRatio") or 1.0)
            if not np.isfinite(ratio) or ratio <= 0:
                ratio = 1.0
            vgain = ratio * (10 ** (float(req.get("vocalGain") or 0) / 20.0))
            igain = 10 ** (float(req.get("instGain") or 0) / 20.0)
            fade_in = max(0.0, float(req.get("fadeIn") or 0))
            fade_out = max(0.0, float(req.get("fadeOut") or 0))
            # 段落静音只作用于人声：区间内把 mono 乘 0，伴奏保持原样。
            muted = []
            for item in req.get("mutedRanges") or []:
                if not isinstance(item, dict):
                    continue
                start = max(0.0, float(item.get("start") or 0))
                end = float(item.get("end") or 0)
                if end > start:
                    muted.append((start, end))
            block = 1 << 20

            with sf.SoundFile(inst) as fi, sf.SoundFile(vocals) as fv:
                if int(fi.samplerate) != 44100 or int(fv.samplerate) != 44100:
                    raise ValueError("混音只支持 44.1 kHz 的会话文件")
                total = int(fi.frames)
                if total <= 0:
                    raise ValueError("伴奏是空文件")
                duration = total / 44100.0

                def blocks():
                    fi.seek(0)
                    fv.seek(0)
                    pos = 0
                    while pos < total:
                        n = min(block, total - pos)
                        a = fi.read(n, dtype="float32", always_2d=True)
                        b = fv.read(n, dtype="float32", always_2d=True)
                        if b.shape[0] < n:
                            b = np.pad(b, ((0, n - b.shape[0]), (0, 0)))
                        mono = b.mean(axis=1).astype(np.float64)
                        if muted:
                            t = (np.arange(pos, pos + n, dtype=np.float64) + 0.5) / 44100.0
                            gate = np.ones(n, dtype=np.float64)
                            for start, end in muted:
                                gate[(t >= start) & (t < end)] = 0.0
                            mono = mono * gate
                        yield pos, a.astype(np.float64), mono
                        pos += n

                def weights(pos: int, n: int):
                    t = (np.arange(pos, pos + n, dtype=np.float64) + 0.5) / 44100.0
                    w = np.ones(n, dtype=np.float64)
                    if fade_in > 0:
                        w = np.minimum(w, np.clip(t / fade_in, 0.0, 1.0))
                    if fade_out > 0:
                        w = np.minimum(w, np.clip((duration - t) / fade_out, 0.0, 1.0))
                    return w

                def mixed(pos: int, a, mono):
                    return (a * igain + np.tile(mono[:, None], (1, 2)) * vgain) * weights(pos, a.shape[0])[:, None]

                # 第一遍只找峰值：先限幅再写，避免整首削波。
                peak = 0.0
                for pos, a, mono in blocks():
                    peak = max(peak, float(np.abs(mixed(pos, a, mono)).max()))
                scale = 0.99 / peak if peak > 0.99 else 1.0

                os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
                tmp = output + ".tmp.wav"
                with sf.SoundFile(tmp, "w", samplerate=44100, channels=2, subtype="PCM_16") as sink:
                    for pos, a, mono in blocks():
                        sink.write((np.clip(mixed(pos, a, mono), -1.0, 1.0) * scale).astype(np.float32))
                if fmt == "wav":
                    os.replace(tmp, output)
                else:
                    with open(tmp, "rb") as src, open(output, "wb") as dst:
                        wav2(src, dst, fmt)
                    os.remove(tmp)
        except ValueError as error:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": str(error)})
            return
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": "重混失败：%s" % traceback.format_exc()[-1200:]})
            return
        emit({
            "type": "result",
            "id": req_id,
            "ok": True,
            "ms": int((time.time() - began) * 1000),
            "sampleRate": 44100,
            "peakScale": round(scale, 3),
            "durationSec": round(duration, 3),
        })

    def vocal_only(req: dict) -> None:
        """清唱：只渲染变声后的人声，按与翻唱版相同的 rmsRatio / vocalGain 对齐响度。

        只读 `vocals/conv.wav`，不重新分离/变声；输出单声道 44.1 kHz，
        格式跟随 `format`（wav / mp3），桌宠播放器两种都能播。
        """
        import numpy as np
        import soundfile as sf

        req_id = req.get("id")
        vocals = req.get("vocals") or ""
        output = req.get("output") or ""
        fmt = (req.get("format") or "wav").lower()
        if fmt not in ("wav", "mp3"):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": "未知的输出格式：%s" % fmt})
            return
        if not output:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": "缺少输出路径"})
            return
        if not vocals or not os.path.isfile(vocals):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "读不到人声：%s" % vocals})
            return

        began = time.time()
        try:
            ratio = float(req.get("rmsRatio") or 1.0)
            if not np.isfinite(ratio) or ratio <= 0:
                ratio = 1.0
            vgain = ratio * (10 ** (float(req.get("vocalGain") or 0) / 20.0))
            fade_in = max(0.0, float(req.get("fadeIn") or 0))
            fade_out = max(0.0, float(req.get("fadeOut") or 0))
            muted = []
            for item in req.get("mutedRanges") or []:
                if not isinstance(item, dict):
                    continue
                start = max(0.0, float(item.get("start") or 0))
                end = float(item.get("end") or 0)
                if end > start:
                    muted.append((start, end))
            block = 1 << 20

            with sf.SoundFile(vocals) as fv:
                if int(fv.samplerate) != 44100:
                    raise ValueError("清唱只支持 44.1 kHz 的会话文件")
                total = int(fv.frames)
                if total <= 0:
                    raise ValueError("人声是空文件")
                duration = total / 44100.0

                def blocks():
                    fv.seek(0)
                    pos = 0
                    while pos < total:
                        n = min(block, total - pos)
                        data = fv.read(n, dtype="float32", always_2d=True)
                        mono = data.mean(axis=1).astype(np.float64)
                        if muted:
                            t = (np.arange(pos, pos + n, dtype=np.float64) + 0.5) / 44100.0
                            gate = np.ones(n, dtype=np.float64)
                            for start, end in muted:
                                gate[(t >= start) & (t < end)] = 0.0
                            mono = mono * gate
                        yield pos, mono
                        pos += n

                def weights(pos: int, n: int):
                    t = (np.arange(pos, pos + n, dtype=np.float64) + 0.5) / 44100.0
                    w = np.ones(n, dtype=np.float64)
                    if fade_in > 0:
                        w = np.minimum(w, np.clip(t / fade_in, 0.0, 1.0))
                    if fade_out > 0:
                        w = np.minimum(w, np.clip((duration - t) / fade_out, 0.0, 1.0))
                    return w

                def shaped(pos: int, mono):
                    return mono * vgain * weights(pos, mono.shape[0])

                peak = 0.0
                for pos, mono in blocks():
                    peak = max(peak, float(np.abs(shaped(pos, mono)).max()))
                scale = 0.99 / peak if peak > 0.99 else 1.0

                os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
                tmp = output + ".tmp.wav"
                with sf.SoundFile(tmp, "w", samplerate=44100, channels=1, subtype="PCM_16") as sink:
                    for pos, mono in blocks():
                        sink.write(np.clip(shaped(pos, mono) * scale, -1.0, 1.0).astype(np.float32))
                if fmt == "wav":
                    os.replace(tmp, output)
                else:
                    with open(tmp, "rb") as src, open(output, "wb") as dst:
                        wav2(src, dst, fmt)
                    os.remove(tmp)
        except ValueError as error:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": str(error)})
            return
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": "清唱渲染失败：%s" % traceback.format_exc()[-1200:]})
            return
        emit({
            "type": "result",
            "id": req_id,
            "ok": True,
            "ms": int((time.time() - began) * 1000),
            "sampleRate": 44100,
            "channels": 1,
            "peakScale": round(scale, 3),
            "durationSec": round(duration, 3),
        })

    def convert_range(req: dict) -> None:
        """只重跑一段时间，拼回 conv.wav；选区外的样本一个都不动。

        窗口比选区多读 `contextSec`（默认 0.5 秒）给模型上下文，但只把 `[startSec, endSec)`
        的结果写回去。交叉淡化放在选区**内部**，因此选区外逐样本不变，接缝又不会爆音。
        """
        import shutil
        import tempfile
        from math import gcd

        import numpy as np
        import soundfile as sf
        from scipy.signal import resample_poly

        req_id = req.get("id")

        def as_float(value, default):
            try:
                result = float(value)
                return result if np.isfinite(result) else default
            except (TypeError, ValueError):
                return default

        voice_name = (req.get("voice") or "").strip() or default_voice
        stem = req.get("stem") or ""
        conv_path = req.get("conv") or ""
        if not stem or not os.path.isfile(stem):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "读不到人声分轨：%s" % stem})
            return
        if not conv_path or not os.path.isfile(conv_path):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "读不到变声结果：%s" % conv_path})
            return
        try:
            load_voice(voice_name)
        except Exception as error:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": str(error)})
            return

        start_sec = as_float(req.get("startSec"), None)
        end_sec = as_float(req.get("endSec"), None)
        if start_sec is None or end_sec is None or start_sec < 0 or end_sec - start_sec < 0.05:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": "选段无效：需要 startSec ≥ 0 且 endSec - startSec ≥ 0.05 秒"})
            return
        out_sr = int(as_float(req.get("outSr"), 44100))
        if out_sr <= 0:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": "输出采样率无效"})
            return
        context = min(5.0, max(0.0, as_float(req.get("contextSec"), 0.5)))
        seam_sec = min(2.0, max(0.0, as_float(req.get("seamSec"), 0.3)))

        try:
            conv, _ = sf.read(conv_path, dtype="float32", always_2d=False)
            if conv.ndim > 1:
                conv = conv.mean(axis=1)
            conv = np.asarray(conv, dtype=np.float32)
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "读不到变声结果：%s" % conv_path})
            return
        total = int(conv.shape[0])
        # 一律先换成整数样本再算长度与偏移，避免浮点累计误差。
        a = max(0, min(int(round(start_sec * out_sr)), total))
        b = max(a, min(int(round(end_sec * out_sr)), total))
        expected = b - a
        if expected < 1:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": "选段超出音频长度"})
            return

        # 段落首次重做前留一份原始音频（只留第一次，后续重做不覆盖）。
        backup_path = (req.get("backupPath") or "").strip()
        backed_up = False
        if backup_path:
            try:
                if not os.path.isfile(backup_path):
                    os.makedirs(os.path.dirname(os.path.abspath(backup_path)), exist_ok=True)
                    sf.write(backup_path, conv[a:b], out_sr, subtype="FLOAT")
                    backed_up = True
            except Exception:
                emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": "写段落备份失败：%s" % traceback.format_exc()[-800:]})
                return

        try:
            stem_info = sf.info(stem)
            stem_sr = int(stem_info.samplerate) or out_sr
            stem_duration = int(stem_info.frames) / float(stem_sr)
            win_start_sec = max(0.0, start_sec - context)
            win_end_sec = min(stem_duration, end_sec + context)
            read_start = max(0, int(round(win_start_sec * stem_sr)))
            read_frames = max(1, int(round(win_end_sec * stem_sr)) - read_start)
            window, window_sr = sf.read(stem, start=read_start, frames=read_frames, dtype="float32", always_2d=True)
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "读不到人声分轨：%s" % stem})
            return
        mono = window.mean(axis=1).astype(np.float32)
        if int(window_sr) != out_sr:
            g = gcd(int(window_sr), out_sr)
            mono = resample_poly(mono, out_sr // g, int(window_sr) // g).astype(np.float32)

        # 选区在窗口里的起点；模型输出与输入窗口等长，按这个偏移取回 [a, b)。
        offset = max(0, int(round(a - win_start_sec * out_sr)))
        target_peak = 0.0
        target = mono[offset:offset + expected]
        if target.size:
            target_peak = float(np.abs(target).max())
        input_peak = as_float(req.get("inputPeak"), 0.0) or 0.0
        factor = 1.0
        if input_peak > 1e-6 and target_peak > 0:
            factor = min(1.0, target_peak / input_peak)

        began = time.time()
        warm = tempfile.mkdtemp(prefix="rvc-range-")
        win_path = os.path.join(warm, "window.wav")
        try:
            sf.write(win_path, mono, out_sr, subtype="PCM_16")
            # run_vc 直接返回 (sampleRate, int16 波形)；失败时第二项是 None。
            sample_rate, piece = run_vc(
                win_path,
                int(as_float(req.get("pitch"), 0)),
                as_float(req.get("indexRate"), 0.3),
                as_float(req.get("protect"), 0.33),
                True,
            )
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": traceback.format_exc()[-1500:]})
            return
        finally:
            shutil.rmtree(warm, ignore_errors=True)
        if piece is None:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": _last_line(sample_rate)})
            return

        model_sr, piece = int(sample_rate), np.asarray(piece)
        if piece.ndim > 1:
            piece = piece.mean(axis=1)
        piece = piece.astype(np.float32) / 32768.0 if piece.dtype.kind in "iu" else piece.astype(np.float32)
        if model_sr != out_sr:
            g = gcd(model_sr, out_sr)
            piece = resample_poly(piece, out_sr // g, model_sr // g).astype(np.float32)
        # 选段重跑也走高音幻觉保护与气声保护（干声窗口与输出窗口同起点、同采样率）。
        try:
            piece = high_guard(piece, mono, out_sr, out_sr, pitch=int(as_float(req.get("pitch"), 0)))
            piece = breath_guard(piece, mono, out_sr, out_sr)
        except Exception as error:
            print("[rvc] 选段气声保护跳过：%s" % error, file=sys.stderr)
        piece = piece[offset:offset + expected] if piece.size > offset else np.zeros(0, dtype=np.float32)
        if piece.size < expected:
            piece = np.pad(piece, (0, expected - piece.size))
        piece = piece * factor

        # 交叉淡化只作用于选区内：区间外一个样本都不改写。
        old = conv[a:b].astype(np.float32, copy=True)
        seam = min(int(round(seam_sec * out_sr)), expected // 2)
        if seam > 0:
            w = np.ones(expected, dtype=np.float32)
            w[:seam] = np.linspace(0.0, 1.0, seam, endpoint=False, dtype=np.float32)
            w[-seam:] = np.linspace(1.0, 0.0, seam, dtype=np.float32)
            conv[a:b] = old * (1.0 - w) + piece * w
        else:
            conv[a:b] = piece

        try:
            os.makedirs(os.path.dirname(os.path.abspath(conv_path)), exist_ok=True)
            # 先留一份上一次的整轨，写坏了还能手动找回。
            shutil.copyfile(conv_path, conv_path + ".bak")
            tmp = conv_path + ".part.wav"
            sf.write(tmp, conv, out_sr, subtype="FLOAT")
            if int(sf.info(tmp).frames) != total:
                raise ValueError("拼接后的长度与原文件不一致")
            os.replace(tmp, conv_path)
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": "写回失败：%s" % traceback.format_exc()[-800:]})
            return
        emit({
            "type": "result",
            "id": req_id,
            "ok": True,
            "ms": int((time.time() - began) * 1000),
            "sampleRate": out_sr,
            "durationSec": round(total / float(out_sr), 3),
            "peakFactor": round(factor, 4),
            "backedUp": backed_up,
            "spliced": {"start": a, "end": b, "expected": expected},
        })

    def peaks(req: dict) -> None:
        """返回波形绘制用的 min/max 包络（约 1200 个桶），面板拖选用。"""
        import numpy as np
        import soundfile as sf

        req_id = req.get("id")
        path = req.get("path") or ""
        if not path or not os.path.isfile(path):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "读不到音频：%s" % path})
            return
        began = time.time()
        try:
            data, sr = sf.read(path, dtype="float32", always_2d=True)
            mono = data.mean(axis=1) if data.shape[1] > 1 else data[:, 0]
            n = int(mono.shape[0])
            buckets = int(np.clip(int(req.get("buckets") or 1200), 64, 4000))
            edges = np.linspace(0, n, buckets + 1).astype(np.int64)
            low = []
            high = []
            for i in range(buckets):
                s, e = int(edges[i]), int(edges[i + 1])
                if e <= s:
                    low.append(0.0)
                    high.append(0.0)
                    continue
                seg = mono[s:e]
                low.append(round(float(seg.min()), 4))
                high.append(round(float(seg.max()), 4))
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "读取波形失败：%s" % traceback.format_exc()[-800:]})
            return
        emit({
            "type": "result",
            "id": req_id,
            "ok": True,
            "ms": int((time.time() - began) * 1000),
            "sampleRate": int(sr),
            "durationSec": round(n / float(sr), 3),
            "peaks": {"buckets": buckets, "frames": n, "min": low, "max": high},
        })

    def restore_range(req: dict) -> None:
        """用段落备份逐样本还原 conv 的一段：不跑模型、不做淡化，样本级一致。"""
        import shutil

        import numpy as np
        import soundfile as sf

        req_id = req.get("id")
        conv_path = req.get("conv") or ""
        backup_path = req.get("backup") or ""
        if not conv_path or not os.path.isfile(conv_path):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "读不到变声结果：%s" % conv_path})
            return
        if not backup_path or not os.path.isfile(backup_path):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": "找不到段落备份：%s" % backup_path})
            return
        try:
            start = int(req.get("start"))
            end = int(req.get("end"))
        except (TypeError, ValueError):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": "还原区间必须是整数样本"})
            return
        began = time.time()
        try:
            conv, sr = sf.read(conv_path, dtype="float32", always_2d=False)
            if conv.ndim > 1:
                conv = conv.mean(axis=1)
            conv = np.asarray(conv, dtype=np.float32)
            piece, _ = sf.read(backup_path, dtype="float32", always_2d=False)
            if piece.ndim > 1:
                piece = piece.mean(axis=1)
            piece = np.asarray(piece, dtype=np.float32)
            total = int(conv.shape[0])
            start = max(0, min(start, total))
            end = max(start, min(end, total))
            if piece.shape[0] != end - start:
                raise ValueError("备份长度与段落不一致（%d vs %d）" % (piece.shape[0], end - start))
            conv[start:end] = piece
            shutil.copyfile(conv_path, conv_path + ".bak")
            tmp = conv_path + ".part.wav"
            sf.write(tmp, conv, int(sr), subtype="FLOAT")
            if int(sf.info(tmp).frames) != total:
                raise ValueError("还原后的长度与原文件不一致")
            os.replace(tmp, conv_path)
        except ValueError as error:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": str(error)})
            return
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": "还原失败：%s" % traceback.format_exc()[-800:]})
            return
        emit({
            "type": "result",
            "id": req_id,
            "ok": True,
            "ms": int((time.time() - began) * 1000),
            "sampleRate": int(sr),
            "durationSec": round(total / float(sr), 3),
            "restored": {"start": start, "end": end},
        })

    f0_cache = {"model": None}

    def export_f0(req: dict) -> None:
        """只读导出音高曲线：对分离人声跑一次 RMVPE，写 `time,f0` CSV（10 ms 一帧）。"""
        import numpy as np

        req_id = req.get("id")
        source = req.get("input") or ""
        output = req.get("output") or ""
        if not source or not os.path.isfile(source):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "读不到人声分轨：%s" % source})
            return
        if not output:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": "没有指定 CSV 输出路径"})
            return
        began = time.time()
        try:
            from infer.audio import load_audio
            from infer.rmvpe import RMVPE

            if f0_cache["model"] is None:
                f0_cache["model"] = RMVPE(os.path.join(assets, "rmvpe", "rmvpe.pt"), False)
            threshold = float(req.get("threshold") or 0.03)
            audio = load_audio(source, 16000)
            f0 = np.asarray(f0_cache["model"].infer_from_audio(audio, thred=threshold), dtype=np.float64)
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": traceback.format_exc()[-1500:]})
            return
        try:
            os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
            tmp = output + ".tmp.csv"
            with open(tmp, "w", encoding="utf-8", newline="") as sink:
                sink.write("time,f0\n")
                for index, value in enumerate(f0):
                    sink.write("%.3f,%.3f\n" % (index / 100.0, float(value)))
            os.replace(tmp, output)
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "写 CSV 失败：%s" % traceback.format_exc()[-800:]})
            return
        frames = int(f0.shape[0])
        emit({
            "type": "result",
            "id": req_id,
            "ok": True,
            "ms": int((time.time() - began) * 1000),
            "frames": frames,
            "frameRate": 100,
            "durationSec": round(frames / 100.0, 3),
        })

    def master(req: dict) -> None:
        """母带：按 EBU R128 目标响度整体增益，再只对超过真峰值上限的峰做限幅。

        输出另存，不碰原混音。响度与真峰值都在处理前后实测并回报。
        """
        req_id = req.get("id")
        source = req.get("input") or ""
        output = req.get("output") or ""
        fmt = (req.get("format") or "wav").lower()
        if fmt not in ("wav", "mp3"):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": "未知的输出格式：%s" % fmt})
            return
        if not source or not os.path.isfile(source):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "decode", "error": "读不到混音：%s" % source})
            return
        if not output:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": "缺少输出路径"})
            return
        try:
            target = float(req.get("targetLufs", -14.0))
            ceiling = float(req.get("ceilingDb", -1.0))
        except (TypeError, ValueError):
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": "响度参数不是数字"})
            return
        if target not in LOUDNESS_PRESETS:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param",
                  "error": "只支持 -14 / -16 / -23 LUFS 三档"})
            return
        if not -6.0 <= ceiling <= 0.0:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "param", "error": "真峰值上限应在 -6 到 0 dB 之间"})
            return

        began = time.time()
        try:
            audio = load_song(source)
            processed, stats = master_audio(audio, 44100, target, ceiling)
            os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
            tmp = output + ".tmp.wav"
            write_audio(tmp, processed.T, 44100, fmt)
            os.replace(tmp, output)
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": "母带处理失败：%s" % traceback.format_exc()[-1200:]})
            return
        emit({
            "type": "result",
            "id": req_id,
            "ok": True,
            "ms": int((time.time() - began) * 1000),
            "sampleRate": 44100,
            "durationSec": round(audio.shape[1] / 44100.0, 3),
            "loudness": stats,
        })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            print("[rvc] 忽略非 JSON 行：%s" % line[:200], file=sys.stderr)
            continue
        op = req.get("op")
        if op == "shutdown":
            break
        handler = {
            "convert": convert,
            "separate": separate,
            "cover": cover,
            "reconvert": reconvert,
            "remix": remix,
            "vocalOnly": vocal_only,
            "encode": encode,
            "convertRange": convert_range,
            "peaks": peaks,
            "restoreRange": restore_range,
            "f0": export_f0,
            "master": master,
        }.get(op)
        if not handler:
            print("[rvc] 未知指令：%s" % op, file=sys.stderr)
            continue
        try:
            handler(req)
        finally:
            # 整首重跑/切片推理会留下大量已释放但不还给系统的堆；不收缩的话，
            # 反复重跑会把提交内存越推越高，最后连 30 MB 的分配都失败。
            if op != "peaks":
                _release_memory()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
