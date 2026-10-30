"""MDX-Net 人声分离（ONNX Runtime，CPU）。

模型：`UVR-MDX-NET-Inst_HQ_3.onnx`（UVR / Anjok07 训练，MIT）。模型输出的是**伴奏**，
人声用 `混音 - 伴奏 * compensate` 相减得到——这是 UVR 里 Inst 系列模型的标准做法。

代码移植自 python-audio-separator 0.9.0（MIT，Andrew Beveridge）的 `Separator`，
其本身取自 Ultimate Vocal Remover（MIT，Anjok07）。这里只保留 MDX-Net 的 ONNX 推理路径：
去掉模型下载（模型由插件安装流程下到数据目录）、不落盘、直接收内存里的波形；
有 onnxruntime-gpu 就走显卡，会话建不起来或跑到一半出错自动退回 CPU。

模型参数来自 UVR 的 `mdx_model_data/model_data.json`，按「文件末 10 MB 的 md5」定位
（`55657dd70583b0fedfba5f67df11d711`）：dim_f=3072、dim_t=256、n_fft=6144、compensate=1.022、
primary_stem=Instrumental。换模型必须同时换这几个常量。
"""

import numpy as np
import torch

DIM_F = 3072
DIM_T = 256
N_FFT = 6144
HOP = 1024
DIM_C = 4
COMPENSATE = 1.022
TRIM = N_FFT // 2
N_BINS = N_FFT // 2 + 1


class MdxSeparator:
    """一次载入、反复用；`separate()` 收 44.1 kHz 立体声 float32，回 (人声, 伴奏)。"""

    def __init__(self, model_path: str, denoise: bool = False):
        import onnxruntime as ort

        self.model_path = model_path
        self.provider = "CPU"
        self.session = None
        # 装了 onnxruntime-gpu 且 CUDA/cuDNN 可用就上显卡；建会话失败（缺 DLL 等）直接退回 CPU，不影响出活。
        try:
            if "CUDAExecutionProvider" in ort.get_available_providers():
                self.session = ort.InferenceSession(model_path, providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
                self.provider = "CUDA"
        except Exception:
            self.session = None
        if self.session is None:
            self.session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
        self.denoise = denoise
        self.window = torch.hann_window(window_length=N_FFT, periodic=False)
        self.freq_pad = torch.zeros([1, DIM_C, N_BINS - DIM_F, DIM_T])
        self.chunk_size = HOP * (DIM_T - 1)
        self.gen_size = self.chunk_size - 2 * TRIM

    def _use_cpu(self) -> None:
        """显卡跑到一半出错（显存不够等）时换 CPU 会话，整首重跑一次。"""
        import onnxruntime as ort

        self.session = ort.InferenceSession(self.model_path, providers=["CPUExecutionProvider"])
        self.provider = "CPU"

    def separate(self, mix: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        mix = np.asarray(mix, dtype=np.float32)
        if mix.ndim == 1:
            mix = np.stack([mix, mix])
        if mix.shape[0] != 2:
            raise ValueError("混音必须是单声道或双声道，当前 %d 声道" % mix.shape[0])
        try:
            inst = self._demix(mix)
        except Exception:
            if self.provider != "CUDA":
                raise
            self._use_cpu()
            inst = self._demix(mix)
        vocals = mix - inst * COMPENSATE
        return vocals.astype(np.float32), inst.astype(np.float32)

    # ------------------------------------------------------------------ 内部分块

    def _demix(self, mix: np.ndarray) -> np.ndarray:
        n_sample = mix.shape[1]
        pad = self.gen_size - n_sample % self.gen_size
        padded = np.concatenate(
            (np.zeros((2, TRIM), dtype=np.float32), mix, np.zeros((2, pad), dtype=np.float32),
             np.zeros((2, TRIM), dtype=np.float32)),
            1,
        )
        waves = []
        i = 0
        while i < n_sample + pad:
            waves.append(torch.from_numpy(np.array(padded[:, i : i + self.chunk_size])).float())
            i += self.gen_size
        outputs = [self._run(wave.unsqueeze(0)).squeeze(0) for wave in waves]
        merged = np.concatenate([o.numpy() for o in outputs], axis=-1)
        return merged[:, :n_sample]

    # ------------------------------------------------------------------ 频谱↔波形

    def _run(self, wave: torch.Tensor) -> torch.Tensor:
        """`wave`：(1, 2, chunk)；返回 (2, gen_size)。"""
        spek = self._stft(wave)
        spek[:, :, :3, :] *= 0  # UVR 对最低三个频点清零
        if self.denoise:
            neg = self.session.run(None, {"input": (-spek).numpy()})[0]
            pos = self.session.run(None, {"input": spek.numpy()})[0]
            pred = -neg * 0.5 + pos * 0.5
        else:
            pred = self.session.run(None, {"input": spek.numpy()})[0]
        out = self._istft(torch.from_numpy(pred))
        return out[:, :, TRIM:-TRIM].squeeze(0)

    def _stft(self, x: torch.Tensor) -> torch.Tensor:
        x = x.reshape([-1, self.chunk_size])
        x = torch.stft(x, n_fft=N_FFT, hop_length=HOP, window=self.window, center=True, return_complex=True)
        x = torch.view_as_real(x)
        x = x.permute([0, 3, 1, 2])
        x = x.reshape([-1, 2, 2, N_BINS, DIM_T]).reshape([-1, DIM_C, N_BINS, DIM_T])
        return x[:, :, :DIM_F]

    def _istft(self, x: torch.Tensor) -> torch.Tensor:
        pad = self.freq_pad.repeat([x.shape[0], 1, 1, 1])
        x = torch.cat([x, pad], -2)
        x = x.reshape([-1, 2, 2, N_BINS, DIM_T]).reshape([-1, 2, N_BINS, DIM_T])
        x = x.permute([0, 2, 3, 1]).contiguous()
        x = torch.istft(torch.view_as_complex(x), n_fft=N_FFT, hop_length=HOP, window=self.window, center=True)
        return x.reshape([-1, 2, self.chunk_size])
