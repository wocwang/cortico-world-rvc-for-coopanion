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
   "voice":"daifeiyu","pitch":2,"indexRate":0.3,"protect":0.33,"inputPeak":0.91}
  {"op":"peaks","id":6,"path":"vocals/conv.wav","buckets":1200}
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

    def voice_path(name: str) -> str:
        base = name if name.lower().endswith(".pth") else name + ".pth"
        return os.path.join(voices, base)

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
        print("[rvc] 已载入音色 %s（index: %s）" % (base, current["index"] or "无"), file=sys.stderr)

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
            status, result = vc.vc_single(0, warm, 0, "rmvpe", current["index"], 0.3, 0, 1.0, 0.33)
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
    separation = {"model": None}
    # 长音频切片：整段一次性喂给 HuBERT，显卡紧张时会 CUDA OOM（实测 2 分钟人声 + gpt-sovits 共存）。
    CHUNK_SECONDS = 20.0
    OVERLAP_SECONDS = 0.3

    def run_vc(path: str, pitch: int, index_rate: float, protect: float, chunked: bool = True):
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
            status, result = vc.vc_single(0, path, pitch, "rmvpe", current["index"], index_rate, 0, 1.0, protect)
            if not result or result[0] is None or result[1] is None:
                return status, None
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
                status, result = vc.vc_single(0, tmp, pitch, "rmvpe", current["index"], index_rate, 0, 1.0, protect)
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
        return sample_rate, (np.clip(mixed, -1.0, 1.0) * 32767).astype(np.int16)

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
            load_audio(source, 16000)  # 先单独解码一次，解码失败按 400 报，不算推理失败
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
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": str(result[0] if result else "没有可转换的音频")[-1500:]})
            return
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
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": "分离失败：%s" % traceback.format_exc()[-1500:]})
            return
        separate_ms = int((time.time() - began) * 1000)

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
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": str(result[0] if result else "没有可转换的音频")[-1500:]})
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
            if stem_dir:
                conv_path = os.path.join(stem_dir, "vocals", "conv.wav")
                os.makedirs(os.path.dirname(os.path.abspath(conv_path)), exist_ok=True)
                sf.write(conv_path, conv, 44100, subtype="FLOAT")
            # 电平对齐：RVC 输出被峰值归一化过，直接叠会盖过伴奏；按原人声的 RMS 比例把音量拉回来。
            rms_vocal = float(np.sqrt(np.mean(vocals ** 2)))
            rms_conv = float(np.sqrt(np.mean(conv ** 2)))
            ratio = 1.0 if rms_vocal < 1e-5 or rms_conv < 1e-5 else min(4.0, max(0.25, rms_vocal / rms_conv))
            gain = ratio * (10 ** (float(req.get("vocalGain") or 0) / 20.0))
            out = instrumental + np.tile(conv, (2, 1)) * gain
            peak = float(np.abs(out).max())
            scale = 1.0
            if peak > 0.99:
                scale = 0.99 / peak
                out *= scale
            write_audio(req.get("output") or "", out.T, 44100, fmt)
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
            "durationSec": round(n / 44100.0, 3),
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
                        yield pos, a.astype(np.float64), b.mean(axis=1).astype(np.float64)
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
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": str(sample_rate)[-1500:]})
            return

        model_sr, piece = int(sample_rate), np.asarray(piece)
        if piece.ndim > 1:
            piece = piece.mean(axis=1)
        piece = piece.astype(np.float32) / 32768.0 if piece.dtype.kind in "iu" else piece.astype(np.float32)
        if model_sr != out_sr:
            g = gcd(model_sr, out_sr)
            piece = resample_poly(piece, out_sr // g, model_sr // g).astype(np.float32)
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
        if op == "convert":
            convert(req)
            continue
        if op == "separate":
            separate(req)
            continue
        if op == "cover":
            cover(req)
            continue
        if op == "remix":
            remix(req)
            continue
        if op == "convertRange":
            convert_range(req)
            continue
        if op == "peaks":
            peaks(req)
            continue
        print("[rvc] 未知指令：%s" % op, file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
