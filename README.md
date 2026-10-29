# RVC唱歌-大肥鱼 — Coopanion World

把任意一段音频换成桌宠的音色。全程本机推理，不上传任何录音。

- `POST /convert`（`multipart/form-data`，默认 `127.0.0.1:9881`）：上传音频，拿回变声后的 wav/mp3。
- 面板：服务状态、变调、索引率、保护清辅音、上传试听与落盘（T3 起）。
- 只做**推理**，不做训练；不处理文字、不发 QQ 消息。

## 和其他两个插件一起用

这三个是本机一条完整的声音链路，可以单独装，也可以一起装：

| 插件 | 端口 | 作用 | 启动占用 |
| --- | --- | --- | --- |
| **gpt-sovits**（更好的 GPTSovits 语音） | `:9880` | 说话：文字 → 语音，本机外放，或交给 QQ | 显卡档约 2–3 GB 显存（按需加载后 1.5–2.5 GB）；CPU 档约 4–6 GB 内存 |
| **本插件**（RVC 变声） | `:9881` | 把干声换成小肥鱼 / 星落落大肥鱼的音色 | 显卡档约 1 GB 显存、内存约 2.5 GB（实测）；启动约 25–30 秒 |
| **DiffSinger 唱歌** | `:9882` | 唱歌：歌词 → 绮萱的歌声 | 纯 CPU，内存约 1.3 GB、不占显存（实测）；引擎载入约 7–11 秒 |

配合方式：

- gpt-sovits 的「出口变声」可以把**交给 QQ 的语音**先过这里（0.5.13 起）；
- 唱歌插件的「RVC 后处理」可以把**唱出来的干声**换成这里的音色（`indexRate` / `protect` 可调）；
- 两个开关互不影响：想只换说话、或只换唱歌，分别开关即可。

## 状态

T1 骨架、T2 资产、T3 面板、T4 与 gpt-sovits 联动、T5 验收（已完成）。
gpt-sovits 0.5.13 起可在「与其他插件联动」页打开「出口变声」：交给 QQ 等插件的音频会先过这里，
失败或超时原样放行。整链冒烟脚本在 `pr-gpt-sovits/repo/scripts/smoke-rvc.mts`。
0.1.1 修复：CPU 档运行时缺 `tools/asr` 时，其 `tools/` 会遮住本插件的同名模块，worker 起不来；
0.1.2 起改为只在缺目录/路径不存在时给出明确原因，并正确剔除运行时的 `tools/`。
0.1.2 修复：宿主的 `ctx.packageDir` 指向加载它的 bot 包（`resources/app/build/cortico/bots/<bot>`），
不是本扩展的安装目录；现在改用本包 `src/definition.ts` 的 `import.meta.url` 定位 `vendor/rvc`。
0.2.0 起「推理档」可选自动 / 显卡 / CPU：切档后点「重启引擎」会自动重建派生 venv（GPU 档约 0.6–0.8 GB 显存）。
0.2.1：示例音色授权改为「个人非商业」（非 MIT）；删掉「建议 60 秒以内」；面板与配置补显存/内存占用提示。

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
  一键安装先建派生 venv 并补 `faiss-cpu`、`praat-parselmouth`，再下约 692 MB 权重，装完自动重拉引擎。
- **变声**：上传音频 → 变调 / 索引率 / 保护清辅音 → 试听 → 下载；结果同时存到 `<插件数据目录>/out`。
- **音色**：列出 `.pth` / `.index`，导入自备权重，一键设为默认。

面板产物是 `dist/webui.js` + `dist/webui.css`（`pnpm run build`，esbuild 打包，约 13 kB）；
上传走 World 内部调用 `convert`：base64 进、`$binary` 出，不经 gpt-sovits。配置组走框架自带配置视图。

## 运行时

- RVC 推理代码：`RVC-Project/Retrieval-based-Voice-Conversion-WebUI` @ `81eed5e`（无 fairseq，HuBERT 走 transformers）。
  瘦身副本随包分发在 `vendor/rvc`（`infer`、`configs`、`i18n` 的 `zh_CN`/`en_US` 语言包、几个 `tools/*.py`），
  29 个文件 / 约 0.26 MB；整包 tgz 约 100 kB（解包 391 kB，含面板 bundle）。
- **权重不进包**：`hubert_base`（transformers 三件套）、`rmvpe.pt`、示例音色共约 692 MB，首次安装时下到
  `<插件数据目录>/assets` 与 `<插件数据目录>/voices`：先写 `.partial` 再校验 SHA-256 才改名，断点续传；
  来源顺序为自有 ModelScope 仓库 → GitHub Release（示例音色）/ hf-mirror → huggingface（上游资产）。
  也可把现成的 `.pth` / `.index` 直接放进 `voices` 目录。
- 解释器：从共享运行时派生的私有 venv（`--system-site-packages`），只补 `faiss-cpu`、`praat-parselmouth`；
  **不复制、也不修改**共享运行时。共享运行时优先复用部署里 `runtimes/gpt-sovits/` 下的任意一档（谁装的都行），
  没有的话点面板「安装」会自己下一份（`auto` 检测到 NVIDIA 就下显卡档约 4 GB，否则 CPU 档约 1 GB，
  装到同一位置，和 gpt-sovits / 唱歌插件共用），所以不装 gpt-sovits 插件也能单用。
- 常驻 worker + 启动预热：热态约 0.3 秒，显存峰值 545–773 MB。worker 只从 `assetsDir` 读权重，不写 `vendor`。

## 示例音色

内置两个可选音色，都由安装流程下载到 `voices`：

- **小肥鱼**（ID `daifeiyu`）：用 gpt-sovits 的 `dfy` 干音自训的 RVC v2 40k 模型；
- **星落落大肥鱼**（ID `xll`）：官方 `YukiKaze1337/DaFeiYu_rvc_v2_40k`，MIT 授权，从 hf-mirror 下载。

`.pth` 与 `.index` 不随包分发。

内置权重是用 gpt-sovits 的 `dfy` 干音自训的 RVC v2 40k 模型（生成器 + faiss 索引），底模
`f0G40k.pth` / `f0D40k.pth` 来自 RVC-Project 官方预训练。训练集是全部 606 条日语干音 / 29.46 分钟：
21 条《人是猫》翻唱切片（B 站 `BV1freb6iErC`，AI 合成人声）+ 585 条 GPT-SoVITS 合成素材，切成 648 段
40 kHz 音频；RMVPE f0，HuBERT 768 维特征。RVC 训练只吃音频，不需要文本或语言标注；这批素材是日语，所以换中文输入会
带一点日语口音与韵律。官方模型即上面的「星落落大肥鱼」，可与小肥鱼并存在音色列表里切换。

**小肥鱼的授权不是 MIT**：**仅供个人学习、娱乐和非商业使用，注明音源即可；请勿冒充他人、用于诈骗或伪造。**
训练素材是机械合成音（非真人录音），音色来源见 B 站 `BV1cbH56KER3`（UP 主「星落落_oi」：
「自用随意，不可商用」）；**音源作者已确认非商业使用、注明音源即可**，所以本插件在非商业场景内置该音色，
并在 README、市场简介与面板里注明来源。**商用需另行取得音源作者授权。** 上游 RVC-Project 为 MIT；
`hubert_base` / `rmvpe.pt` 来自 `lj1995/VoiceConversionWebUI`。

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
