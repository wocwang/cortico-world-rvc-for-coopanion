# RVC 变声 — Coopanion World

把任意一段音频换成桌宠的音色。全程本机推理，不上传任何录音。

- `POST /convert`（`multipart/form-data`，默认 `127.0.0.1:9881`）：上传音频，拿回变声后的 wav/mp3。
- 面板：服务状态、变调、索引率、保护清辅音、上传试听与落盘（T3 起）。
- 只做**推理**，不做训练；不处理文字、不发 QQ 消息。

## 状态

T1 骨架、T2 资产、T3 面板（已完成）：常驻 worker、HTTP 接口、权重下载与音色导入，以及三个面板。
T4 与 gpt-sovits 联动、T5 验收见仓库根目录的 `tasks.md` / `spec.md`。

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

## 面板

- **服务**：引擎 / 派生 venv / 权重 / 音色 / 接口五行状态，一键安装、取消与重启引擎，日志尾部。
  一键安装先建派生 venv 并补 `faiss-cpu`、`praat-parselmouth`，再下 587 MB 权重，装完自动重拉引擎。
- **变声**：上传音频 → 变调 / 索引率 / 保护清辅音 → 试听 → 下载；结果同时存到 `<插件数据目录>/out`。
- **音色**：列出 `.pth` / `.index`，导入自备权重，一键设为默认。

面板产物是 `dist/webui.js` + `dist/webui.css`（`pnpm run build`，esbuild 打包，约 13 kB）；
上传走 World 内部调用 `convert`：base64 进、`$binary` 出，不经 gpt-sovits。配置组走框架自带配置视图。

## 运行时

- RVC 推理代码：`RVC-Project/Retrieval-based-Voice-Conversion-WebUI` @ `81eed5e`（无 fairseq，HuBERT 走 transformers）。
  瘦身副本随包分发在 `vendor/rvc`（`infer`、`configs`、`i18n` 的 `zh_CN`/`en_US` 语言包、几个 `tools/*.py`），
  29 个文件 / 约 0.26 MB；整包 tgz 约 100 kB（解包 391 kB，含面板 bundle）。
- **权重不进包**：`hubert_base`（transformers 三件套）、`rmvpe.pt`、示例音色共约 587 MB，首次安装时下到
  `<插件数据目录>/assets` 与 `<插件数据目录>/voices`：先写 `.partial` 再校验 SHA-256 才改名，断点续传；
  来源顺序为自有 ModelScope 仓库 → hf-mirror → huggingface。也可把现成的 `.pth` / `.index` 直接放进 `voices` 目录。
- 解释器：从 gpt-sovits 运行时派生的私有 venv（`--system-site-packages`），只补 `faiss-cpu`、`praat-parselmouth`；
  **不复制、也不修改**共享运行时。
- 常驻 worker + 启动预热：热态约 0.3 秒，显存峰值 545–773 MB。worker 只从 `assetsDir` 读权重，不写 `vendor`。

## 示例音色

`YukiKaze1337/DaFeiYu_rvc_v2_40k`（大肥鱼，MIT）。`.pth` 与 `.index` 不随包分发，由安装流程下载到 `voices` 目录；
上游 RVC-Project 为 MIT；`hubert_base` / `rmvpe.pt` 来自 `lj1995/VoiceConversionWebUI`。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm run build   # 面板 bundle → dist/webui.js + dist/webui.css
# 真实链路冒烟（需要本机的派生 venv 与一份上游 assets/；可用 RVC_SMOKE_* 覆盖路径）
# 默认用包内 vendor/rvc 当代码目录，权重硬链接到 %TEMP%\rvc-smoke\assets 模拟安装结果
pnpm exec tsx scripts/smoke.mts
```

## 许可

MIT，见 `LICENSE`。
