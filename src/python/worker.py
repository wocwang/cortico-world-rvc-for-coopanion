"""常驻 RVC 推理 worker。

由 `src/engine.ts` 启动：`python worker.py <codeDir> <voicesDir> <assetsDir>`。
`codeDir` 是包内的 `vendor/rvc`（只读），模型资产在 `assetsDir`（hubert_base/、rmvpe/）。
启动时载入 RVC 代码与默认音色、预热一次，然后按行读 stdin 的 JSON 请求、按行写 stdout 的 JSON 结果。

stdout 只放协议行（原 fd 被 dup 出来单独写，其余输出统统改到 stderr），
所以上游 RVC / i18n / torch 的 print 不会污染协议。

请求：
  {"op":"convert","id":1,"input":"a.wav","output":"b.wav","voice":"daifeiyu",
   "pitch":0,"indexRate":0.3,"protect":0.33,"format":"wav"}
  {"op":"shutdown"}

回复：
  {"type":"ready","device":"cuda:0","model":"daifeiyu","warn":null}
  {"type":"result","id":1,"ok":true,"ms":123,"sampleRate":40000}
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
    sys.path.insert(0, root)
    os.chdir(root)

    os.environ["weight_root"] = voices
    os.environ["index_root"] = voices
    os.environ["outside_index_root"] = voices
    os.environ["rmvpe_root"] = os.path.join(assets, "rmvpe")
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

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
            warm = os.path.join(voices, ".warmup.wav")
            sf.write(warm, (0.1 * np.sin(2 * np.pi * 220.0 * t)).astype(np.float32), sr)
            status, result = vc.vc_single(0, warm, 0, "rmvpe", current["index"], 0.3, 0, 1.0, 0.33)
            if not result or result[1] is None:
                warn = "预热失败（仍按就绪处理）：%s" % str(status).splitlines()[-1][:200]
                print("[rvc] %s" % warn, file=sys.stderr)
            for path in (warm,):
                try:
                    os.remove(path)
                except OSError:
                    pass
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

    def write_audio(path: str, audio, sample_rate: int, output_format: str) -> None:
        import soundfile as sf

        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        if output_format in ("wav", "flac"):
            sf.write(path, audio, sample_rate)
            return
        with BytesIO() as wav_file:
            sf.write(wav_file, audio, sample_rate, format="wav")
            wav_file.seek(0)
            with open(path, "wb") as out:
                wav2(wav_file, out, output_format)

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
            status, result = vc.vc_single(
                0, source,
                int(req.get("pitch") or 0),
                "rmvpe",
                current["index"],
                float(req.get("indexRate", 0.3)),
                0,
                1.0,
                float(req.get("protect", 0.33)),
            )
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": traceback.format_exc()[-1500:]})
            return
        if not result or result[0] is None or result[1] is None:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": str(status)[-1500:]})
            return
        try:
            write_audio(req.get("output") or "", result[1], int(result[0]), fmt)
        except Exception:
            emit({"type": "result", "id": req_id, "ok": False, "kind": "infer", "error": "写出失败：%s" % traceback.format_exc()[-800:]})
            return
        emit({"type": "result", "id": req_id, "ok": True, "ms": int((time.time() - began) * 1000), "sampleRate": int(result[0])})

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
        print("[rvc] 未知指令：%s" % op, file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
