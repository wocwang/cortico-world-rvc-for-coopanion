# RVC 变声 — Coopanion World

把任意一段音频换成桌宠的音色。全程本机推理，不上传任何录音。

- `POST /convert`（`multipart/form-data`，默认 `127.0.0.1:9881`）：上传音频，拿回变声后的 wav/mp3。
- 面板：服务状态、变调、索引率、保护清辅音、上传试听与落盘（T3 起）。
- 只做**推理**，不做训练；不处理文字、不发 QQ 消息。

## 状态

T1 骨架（已完成）：World 生命周期、配置、常驻 worker、HTTP 接口、串行队列与测试。
T2 资产安装、T3 面板、T4 与 gpt-sovits 联动、T5 验收见仓库根目录的 `tasks.md` / `spec.md`。

## 接口

`GET /health` → `{ ok, ready, device, model, queue }`

`POST /convert`（字段全部可选，`file` 必填）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `file` | — | wav / flac / mp3 / ogg / m4a |
| `voice` | 配置的默认音色 | `.pth` 文件名，不含扩展名 |
| `pitch` | `0` | 半音，−24..24 |
| `indexRate` | `0.3` | 0..1，音色没有 `.index` 时忽略 |
| `protect` | `0.33` | 0..0.5 |
| `separator` | `off` | `off`；`uvr5` 在缺 `tools/uvr5` 时回 400 |
| `format` | `wav` | `wav` / `mp3` |
| `save` | `0` | `1` 时另存到插件数据目录，响应带 `X-Rvc-Saved` |

成功回音频字节与 `X-Rvc-Ms`；错误码：400 参数/解码、401 令牌、409 模型未就绪、502 推理失败、503 队列满。
接口只监听 `127.0.0.1`；配了令牌时要求 `Authorization: Bearer` 或 `?token=`。
并发 1，排队上限 4，超出立即 503。

## 运行时

- RVC 推理代码：`RVC-Project/Retrieval-based-Voice-Conversion-WebUI` @ `81eed5e`（无 fairseq，HuBERT 走 transformers）。
- 解释器：从 gpt-sovits 运行时派生的私有 venv（`--system-site-packages`），只补 `faiss-cpu`、`praat-parselmouth`；
  **不复制、也不修改**共享运行时。
- 常驻 worker + 启动预热：热态约 0.3 秒，显存峰值 545–773 MB。

## 示例音色

`YukiKaze1337/DaFeiYu_rvc_v2_40k`（MIT），`.pth` 与 `.index` 随包分发（T2 起）。
上游 RVC-Project 为 MIT；`hubert_base` / `rmvpe.pt` 来自 `lj1995/VoiceConversionWebUI`。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
# 真实链路冒烟（需要本机的派生 venv、RVC 代码目录与一个音色；可用 RVC_SMOKE_* 覆盖路径）
pnpm exec tsx scripts/smoke.mts
```

## 许可

MIT，见 `LICENSE`。
