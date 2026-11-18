"""SwiftF0 音高检测（精简版，只保留插件需要的推理路径）。

本文件与 `swift/model.onnx` 派生自 swift-f0 0.3.0（https://github.com/lars76/swift-f0-training），
MIT License, Copyright (c) 2025-2026 Lars Nieradzik，许可全文见 `swift/LICENSE`。

模型输入 16 kHz 单声道浮点音频，每 256 点（16 ms）输出一个音高与置信度；
置信度 < 0.5 视为无声（清音/静音）。
"""

import os

import numpy as np
import onnxruntime

SAMPLE_RATE = 16000
HOP = 256
FRAME_PERIOD = HOP / SAMPLE_RATE
FMIN = 46.875
FMAX = 2093.75
SILENCE_PEAK = 1e-3
LOOKAHEAD_FRAMES = 10
LEFT_FRAMES = 11
WINDOW_FRAMES = 1875

MODEL_PATH = os.path.join(os.path.dirname(__file__), "swift", "model.onnx")


class SwiftF0:
    """复用同一个 ONNX 会话；构造约 20 ms。"""

    def __init__(self, model_path=None, threads=2, spin=False):
        options = onnxruntime.SessionOptions()
        if threads:
            options.intra_op_num_threads = int(threads)
        if not spin:
            options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        self.session = onnxruntime.InferenceSession(
            model_path or MODEL_PATH,
            options,
            providers=["CPUExecutionProvider"],
        )

    def _run(self, window, fmin, fmax):
        pitch, confidence = self.session.run(
            ["pitch", "confidence"],
            {
                "audio": window[None, :],
                "fmin": np.asarray(fmin, dtype=np.float32),
                "fmax": np.asarray(fmax, dtype=np.float32),
            },
        )
        pitch = np.asarray(pitch[0], dtype=np.float64)
        confidence = np.asarray(confidence[0], dtype=np.float64)
        n = len(confidence)
        hops = window[: n * HOP].reshape(n, HOP) if len(window) >= HOP else window[None, :]
        # 数字静音在频谱上落在对数底噪，模型会给出随机有声帧；峰值过低的帧直接判无声。
        confidence[np.abs(hops).max(axis=1) < SILENCE_PEAK] = 0.0
        return pitch, confidence

    def detect(self, audio, fmin=60.0, fmax=1600.0):
        """返回 (pitch_hz, confidence)，均为每 16 ms 一帧、与 audio 起点对齐。"""
        signal = np.asarray(audio, dtype=np.float32)
        if signal.ndim > 1:
            signal = signal.mean(axis=1)
        if signal.size == 0:
            return np.zeros(0), np.zeros(0)
        fmin = float(np.clip(fmin, FMIN, FMAX))
        fmax = float(np.clip(fmax, FMIN, FMAX))
        n = max(1, len(signal) // HOP)
        parts = []
        for start in range(0, n, WINDOW_FRAMES):
            end = min(start + WINDOW_FRAMES, n)
            left = max(0, start - LEFT_FRAMES)
            window = signal[left * HOP : (end + LOOKAHEAD_FRAMES) * HOP] if end < n else signal[left * HOP :]
            pitch, confidence = self._run(window, fmin, fmax)
            parts.append((pitch[start - left : end - left], confidence[start - left : end - left]))
        return (
            np.concatenate([p[0] for p in parts]),
            np.concatenate([p[1] for p in parts]),
        )
