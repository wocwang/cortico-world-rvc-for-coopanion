"""Mel-Band RoFormer 推理（KimberleyJSN 的 MIT 权重）。

只依赖运行时已有的 torch / numpy / librosa，不引入新的 pip 包。
模型结构 vendored 自 KimberleyJensen/Mel-Band-Roformer-Vocal-Model（MIT），
去掉了 beartype 装饰器，其余保持原样。
"""
import numpy as np
import torch
import torch.nn as nn

from .model import MelBandRoformer

SAMPLE_RATE = 44100
CHUNK_SIZE = 352800  # 8 秒 @ 44.1 kHz，训练时同款
NUM_OVERLAP = 2

CONFIG = dict(
    dim=384,
    depth=6,
    stereo=True,
    num_stems=1,
    time_transformer_depth=1,
    freq_transformer_depth=1,
    num_bands=60,
    dim_head=64,
    heads=8,
    attn_dropout=0,
    ff_dropout=0,
    flash_attn=True,
    dim_freqs_in=1025,
    sample_rate=SAMPLE_RATE,
    stft_n_fft=2048,
    stft_hop_length=441,
    stft_win_length=2048,
    stft_normalized=False,
    mask_estimator_depth=2,
    multi_stft_resolution_loss_weight=1.0,
    multi_stft_resolutions_window_sizes=(4096, 2048, 1024, 512, 256),
    multi_stft_hop_size=147,
    multi_stft_normalized=False,
)


def _windowing_array(size: int, fade: int, device) -> torch.Tensor:
    fadein = torch.linspace(0, 1, fade)
    fadeout = torch.linspace(1, 0, fade)
    window = torch.ones(size)
    window[-fade:] *= fadeout
    window[:fade] *= fadein
    return window.to(device)


def _demix(model: nn.Module, mix: torch.Tensor, device) -> np.ndarray:
    """滑窗推理并做加权拼接；mix 是 [2, n]，返回同形状的 vocals。"""
    chunk = CHUNK_SIZE
    step = chunk // NUM_OVERLAP
    fade = chunk // 10
    border = chunk - step

    if mix.shape[1] > 2 * border and border > 0:
        mix = nn.functional.pad(mix, (border, border), mode="reflect")

    windowing = _windowing_array(chunk, fade, device)
    total = mix.shape[1]
    result = torch.zeros((1, 2, total), dtype=torch.float32, device=device)
    counter = torch.zeros((1, 2, total), dtype=torch.float32, device=device)

    with torch.autocast("cuda", dtype=torch.float16):
        with torch.inference_mode():
            i = 0
            while i < total:
                part = mix[:, i:i + chunk]
                length = part.shape[-1]
                if length < chunk:
                    if length > chunk // 2 + 1:
                        part = nn.functional.pad(part, (0, chunk - length), mode="reflect")
                    else:
                        part = nn.functional.pad(part, (0, chunk - length, 0, 0), mode="constant", value=0)

                out = model(part.unsqueeze(0))[0]
                window = windowing.clone()
                if i == 0:
                    window[:fade] = 1
                elif i + chunk >= total:
                    window[-fade:] = 1

                result[..., i:i + length] += out[..., :length] * window[..., :length]
                counter[..., i:i + length] += window[..., :length]
                i += step

    sources = (result / counter).cpu().numpy()
    np.nan_to_num(sources, copy=False, nan=0.0)
    if mix.shape[1] > 2 * border and border > 0:
        sources = sources[..., border:-border]
    return sources[0]


class MelBandSeparator:
    """和 MdxSeparator 一样提供 `separate(mix) -> (vocals, inst)`，mix 是 [2, n]。"""

    def __init__(self, model_path: str):
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA 不可用")
        free, _total = torch.cuda.mem_get_info()
        # 实测整首（约 2 分 20 秒）峰值 2.14 GB：留一点余量，低于 3 GB 直接回退。
        if free < 3 * 1024 ** 3:
            raise RuntimeError("显存不足（可用 %.1f GB，需要约 3 GB）" % (free / 1024 ** 3))

        self.device = torch.device("cuda")
        self.model = MelBandRoformer(**CONFIG)
        state = torch.load(model_path, map_location="cpu", weights_only=True)
        self.model.load_state_dict(state)
        self.model.to(self.device).eval()
        torch.backends.cudnn.benchmark = True
        self.provider = "CUDA"

    def separate(self, mix: np.ndarray):
        source = np.ascontiguousarray(mix, dtype=np.float32)
        tensor = torch.from_numpy(source).to(self.device)
        vocals = _demix(self.model, tensor, self.device)
        instrumental = source - vocals
        return vocals, instrumental
