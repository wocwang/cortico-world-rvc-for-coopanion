# T0 可行性探针 — 结果

日期：2026-10-27 ｜ 结论：**通过**（fairseq 障碍已不存在，速度与显存都达标）

## 环境

- 派生 venv：`python -m venv --system-site-packages %TEMP%\rvc-probe`
  （base = `runtimes\gpt-sovits\e91506f-1\cuda\runtime\python.exe`，**共享运行时未被修改**）
- Python 3.12.13 ｜ torch 2.7.1+cu128 ｜ CUDA 可用 ｜ transformers 4.57.6（运行时自带）
- 只往 venv 补了两个包：`faiss-cpu 1.15.1`、`praat-parselmouth 0.4.7`

## 推理代码

- 仓库：`RVC-Project/Retrieval-based-Voice-Conversion-WebUI`
- commit：`81eed5e8f68b6bed1789f682fe78cdd324495afc`（2026-08-04）
- 该版已现代化：`requirments_cu128_py312.txt`（py3.12 + cu128，两阶段装 torch）、
  **代码里已无 fairseq**（HuBERT 改用 `transformers.HubertModel`，权重是 transformers 目录格式），
  并提供 `infer/cli.py`（`--model/--input/--output/--pitch/--f0-method/--index/--index-rate/--protect/--format`）。

## 资产（HF `lj1995/VoiceConversionWebUI`，本机走 `hf-mirror.com`）

| 文件 | 大小 | 说明 |
|---|---|---|
| `hubert_base/`（config + preprocessor + pytorch_model.bin） | 180.4 MB | transformers 格式 ContentVec |
| `rmvpe.pt` | 172.8 MB | 放在仓库根的 `rmvpe.pt`（不是 `rmvpe/rmvpe.pt`） |
| `dafeiyu.pth` + index | 52.7 MB + 154.5 MB | 示例音色，`YukiKaze1337/DaFeiYu_rvc_v2_40k`，**license: MIT** |

注意：`pretrained_v2/f0G40k.pth`（底模）不能当音色模型用——CLI 报 `Model does not contain weight/emb_g.weight`。

## 实测（RTX 机器，cuda:0，fp16，RMVPE）

| 场景 | 耗时 | 显存峰值 |
|---|---|---|
| 模型加载 `get_vc()` | 1.34s | — |
| 首次转换（含 RMVPE 初始化/图捕获） | 17.43s | 773 MB |
| 5.4s 音频（热） | 0.33s | 545 MB |
| 2.0s 音频（热） | 0.27s | 581 MB |
| 2.0s 音频，新长度首跑 | 1.53s | 742 MB |
| 输出 | 5.38s @ 40kHz，峰值 0.904（无削波） | — |

## 踩到的坑（T1 必须处理）

1. **同名 `tools` 包遮蔽**：派生 venv 继承了 `..`（gpt-sovits 运行时根）这个 sys.path 项，那里也有 `tools/`，
   会遮住本项目的 `tools.cuda_graph`。探针的做法是把「含 `tools/asr` 的外部路径」从 sys.path 剔除；
   T1 的 worker 启动器要固化这一步（或用 `-I` + 显式 sys.path）。
2. **`python infer/cli.py` 直接跑会 `No module named 'infer'`**：要用 `-m infer.cli`（cwd=仓库根）
   或 launcher 里 `runpy.run_module`。
3. **`transformers` 版本偏高**：上游要求 `>=4.49,<4.50`，运行时是 4.57.6，实测 HuBERT 加载/推理正常（记录为风险）。
4. **HF 证书**：本机直连 HF 有 SSL 校验失败 → 全部走 `hf-mirror.com`；会 429 限流，需重试/退避。
5. **冷启动 17s**：T1 引擎必须是**常驻 worker**，启动时先跑一次静音预热，否则第一条请求必超时。

## 对 T1 的影响

- 补装清单确定为 `faiss-cpu`、`praat-parselmouth` 两项（`local-attention`/`torchfcpe`/`onnxruntime-gpu` 只在大模型/其它 F0 方法用到，先不装）。
- 引擎 = 常驻 python worker + JSON 行协议；模型常驻显存（约 0.6 GB，可与 gpt-sovits 共存）。
- `RVC_CUDA_GRAPH`（默认开）会按输入长度缓存图，长度分布离散时可关或限制 `RVC_CUDA_GRAPH_MAX_CACHE`。
