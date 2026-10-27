# Spec — RVC 变声插件（`@wocwang/cortico-world-rvc-for-coopanion`）

状态：三条决策已确认（2026-10-27）；**T0 可行性探针通过后**才进入实现
仓库：`D:\Users\HW W\Documents\pr-rvc\repo`（本 spec 所在目录）
前置：gpt-sovits 0.5.12 已本地提交（`dbb4c54`，未 push），工作树干净

## 1. 背景与定位

- GPT-SoVITS 解决「文字 → 语音」。RVC 解决「任意音频 → 目标音色」，两者正交：
  gpt-sovits 的 `POST /audio/speech` 是**文本进、音频出**，不能承接「音频进」；
  所以 RVC 面板里的「上传音频 → 变声 → 试听/落盘」走 **RVC 自己的 `POST /convert`**（multipart 上传音频），
  不是走 `/audio/speech`。外部程序要用也一样：直接调 `9881/convert`。
- 本机没有现成 RVC 运行时或权重（已扫 `D:\RVC1006` 不存在），T0 需下载推理代码 + hubert/rmvpe。
- 「RVC 快」的前提是**不分离人声**：对 TTS 产物（本来是干净单人声）分离纯属浪费；
  只有用户上传带伴奏的素材时才需要 `separator=uvr5`，而 UVR5 依赖 gpt-sovits 运行时的 `tools/uvr5`
  （旧运行时包不含，缺了就把该选项标成不可用）。

## 2. 已确认决策

1. **串接位置**：gpt-sovits 出口调用 RVC。QQ 侧完全无感；RVC 不可用/超时/报错时**原样返回原音频**，绝不断链路。
2. **作用范围**：只处理「交给其他插件」的音频（即 gpt-sovits 的 HTTP 语音接口出口）；
   **本机对话页不外放变声**。RVC 面板另有独立入口：上传 →（可选）人声分离 → 变声 → 试听 / 落盘。
3. **内置音色**：随包放一个**许可清晰的公开示例音色**（`.pth`，有则带 `.index`）；之后支持用户自备 `.pth/.index`。
4. **前置**：0.5.12 基线已本地提交（不 push）；T0 探针**不改共享运行时**（用派生 venv，见 §7）。

## 3. 目标（本仓库做）

1. 独立 world 插件：`kind = "world"`，只做音频进、音频出；不处理文字、不直接发 QQ 消息。
2. 本机 HTTP 接口（默认 `127.0.0.1:9881`）：`GET /health`、`POST /convert`；单 GPU 串行队列。
3. 自带面板：服务状态、依赖与权重安装进度、音色列表、变调、索引率、保护清辅音、上传试听与落盘、日志。
4. 资产：`hubert_base.pt`、`rmvpe.pt`、示例音色（`.pth` / 可选 `.index`）的下载、校验、断点续传；支持导入自备权重。
5. 与 gpt-sovits 联动：在它的「与其他插件联动」页加一张 RVC 子卡（检测/端点/超时/变调/索引率/一键写入/试听），
   并在其 HTTP 语音接口出口串一次后处理。

## 4. 非目标

- 不做 RVC **训练**（只做推理；训练留给上游 WebUI）。
- 不做文字处理、不发 QQ 消息、不改 qq-final / NapCat。
- 不把 RVC 面板塞进 gpt-sovits；也不在本机对话页（`sovits_speak`）做变声。
- 不修 QQ 群语音「不支持查看」那条外部故障（已定性为 NapCat/客户端侧，本插件管不到）。
- 不做**唱歌**链路（旋律生成 / 歌声合成 / `sing` 工具）。方案存档见 §11，v1 不实现。

## 5. 架构

```
QQ 插件 --POST /audio/speech--> gpt-sovits(9880) --合成--> [出口后处理] --POST /convert--> RVC(9881)
                                                              |  失败/超时: 原样返回原音频
RVC 面板「上传变声」 --world 内部直接调 convert--> RVC(9881) --> 试听 / 落盘
```

- gpt-sovits 侧后处理点：`src/http-tts.ts` 返回前；只对 `POST /audio/speech`（与 `/tts`）生效。
- 队列：RVC 并发 1，其余排队；队列上限（默认 4）超出立即 503，gpt-sovits 侧按失败处理（原样返回）。
- 端口：默认 9881，可配置；只绑 `127.0.0.1`；可选 token（`Authorization: Bearer`，与 gpt-sovits `httpToken` 同款）。

## 6. 接口契约

### `GET /health`
```json
{ "ok": true, "ready": true, "device": "cuda", "model": "示例音色 id", "queue": 0 }
```
`ready=false` 表示权重/依赖没装好；gpt-sovits 侧据此直接跳过（不等待）。

### `POST /convert`（`multipart/form-data`）
| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `file` | 文件 | 必填 | wav / flac / mp3 / ogg / m4a |
| `voice` | string | 内置示例 | 音色 id |
| `pitch` | int | `0` | 半音，−24..24 |
| `indexRate` | float | `0.3` | 0..1；该音色没有 `.index` 时忽略 |
| `protect` | float | `0.33` | 0..0.5，保护清辅音 |
| `separator` | string | `off` | `off` / `uvr5`（缺 `tools/uvr5` 时 400） |
| `format` | string | `wav` | `wav` / `mp3` |
| `save` | 0/1 | `0` | 落盘到插件数据目录；仍然返回音频，另加 `X-Rvc-Saved` 头 |

成功：`200`，`Content-Type: audio/wav`（或 `audio/mpeg`）+ `X-Rvc-Ms`。
错误：`400` 参数/解码失败、`409` 模型未就绪、`502` 推理失败、`503` 队列满。

## 7. 运行时与资产

- **不复制 8.9 GB 运行时**：从 gpt-sovits 的 `runtimes/gpt-sovits/<ver>/<tier>/runtime/python.exe`
  派生**私有 venv**（`python -m venv --system-site-packages`），只往 venv 里补 RVC 需要的包
  （预计 `faiss-cpu`；其余 torch / numpy / librosa / soundfile 复用运行时）。这样**不改共享运行时**。
- RVC 推理代码：pin 一个上游 commit（T0 在 Applio / RVC-Project 之间选，优先 **fairseq-free** 路线）。
- 权重：`hubert_base.pt`、`rmvpe.pt`、示例音色 `.pth`（+可选 `.index`），放插件自己的数据目录，
  带 sha256 与断点续传；用户自备 `.pth/.index` 走导入。
- 版本漂移：记录派生 venv 基于的 gpt-sovits `RUNTIME_VERSION`；升级运行时后提示重建 venv。
- 没装 gpt-sovits 的机器：面板提示「先安装 gpt-sovits（可选 CPU 档）」，不自行下载整套运行时。

## 8. gpt-sovits 侧改动（T4，尽量小）

- `src/config.ts` 新增：`rvc.enabled`、`rvc.endpoint`（默认 `http://127.0.0.1:9881`）、`rvc.token`、
  `rvc.timeoutMs`（默认 8000）、`rvc.pitch`、`rvc.indexRate`、`rvc.protect`。
- `src/http-tts.ts`：合成完 → 若启用 → `POST /convert`（单次，带超时）→ 成功替换字节；
  非 2xx / 超时 / 异常 → **原样返回原音频**，日志限流（同一错误每分钟最多一条）。
- 联动页新增 RVC 子卡：`/health` 检测（未装/未就绪/就绪）、端点、超时、变调、索引率、「一键写入」、试听。
- 开关与配置由 gpt-sovits 持有（QQ 那条链路固定指向 9880，只能在本方出口串接）。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| ~~fairseq 在 py3.12 + torch 2.7 上不可用~~ | **已消除**：上游 `81eed5e` 改用 transformers HuBERT，代码里已无 fairseq（T0 实测通过） |
| 与 gpt-sovits 抢显存 | 实测峰值 545–773 MB，可与推理服务共存；仍用串行队列 + 空闲卸载兜底 |
| gpt-sovits 运行时版本漂移 | venv 记录 base 版本，不匹配提示重建 |
| `transformers` 版本偏高（运行时 4.57.6，上游要求 <4.50） | T0 实测 HuBERT 正常；若后续升级出错，在 venv 里钉 4.49.x |
| 示例音色版权 | 已选 `YukiKaze1337/DaFeiYu_rvc_v2_40k`（license: MIT），README 标注来源 |
| 延迟 | 热态 0.27–0.33s（2s/5.4s 音频）；冷启动 17s → **常驻 worker + 启动预热** |

## 9.1 T0 结论（2026-10-27）

已通过，详见 `probe.md`：派生 venv + `faiss-cpu 1.15.1` + `praat-parselmouth 0.4.7`，
RVC-Project @ `81eed5e`，RMVPE 走 GPU，输出 5.38s @ 40kHz、峰值 0.904。
需要特别处理：外部 `tools` 包遮蔽、`-m infer.cli`/runpy 启动、HF 走 hf-mirror、常驻预热。


## 10. 验收（T5）

- `typecheck` / 测试 / `build` 全绿。
- 本机跑通：gpt-sovits 合成 → 出口串 RVC → 落盘 WAV，听感确认音色改变。
- 面板：上传一条音频 → 变声 → 试听 → 落盘。
- 三种故障（RVC 停止 / 超时 / 返回 500）下，gpt-sovits 仍返回原音频，QQ 链路不断。
- 出 tgz，本地 commit（不 push、不发 release）。

## 11. 后续存档：唱歌链路（v1 不做，2026-10-27 定）

需求来源：让桌宠在 QQ 里「随便唱一句」。RVC 只能换音色 + 整体变调，**不能凭空生成旋律**，
所以唱歌必须在这条链路前面加「旋律 / 人声」来源。两种形态，互不冲突：

### A1 预渲染素材包（优先，成本最低）

- 离线生成 8–12 条 2–4 秒的「唱一句」音频，运行时只随机挑一条播放（可再随机变调/变速）。
- 生成来源二选一：
  - 自己哼/清唱 → RVC 换音色：许可最干净，链路就是 A 方案；
  - DiffSinger/OpenUtau + 中文声库渲染 → RVC：质量更好，但要先查声库许可。
- **运行时零额外显存、零额外延迟**；资产可随包或做可选下载。
- 需要 QQ 侧给 bot 一个 `sing` 工具（或固定彩蛋指令），qq-final 能把音频发成语音。

### A2 动态唱歌链路（后续，成本高）

```
文本/歌词 → 旋律（Magenta / Text2MIDI / MIDI-LLM）
          → 歌声合成（DiffSinger 或 OpenUtau + 中文声库）
          → RVC 换肥鱼音色 → wav
```

- 相当于在 RVC 之外**再加 2–3 个模型**：旋律模型 + SVS 模型 + 声库；RVC 只是最后一道。
- 显存：RVC 实测 0.55–0.8 GB；SVS 估算 1.5–2.5 GB；旋律模型 0–4 GB（Magenta 可 CPU，1B 级 LLM 3–4 GB）。
  串行执行并即时卸载时，峰值约 **2–3 GB**（未实测）。
- 延迟：端到端约 **3–10 秒**，做语音消息可以，实时对话不行。
- 依赖：中文歌词转音素、声库许可、旋律版权（用随机/原创动机规避）、QQ 侧 `sing` 工具与发音频接线。
- 纯 DSP 合成「哼」声（无真人声模型）不采用：RVC 的 HuBERT 特征是真人语音分布，
  合成元音属分布外，转出来闷、抖、带电音味，只够当彩蛋。

### 决策

v1 只做「音频进、音频出」；A1/A2 均不进 T1–T5。等 v1 上线、QQ 侧确有需求，再单独评估 A1（先）→ A2（后）。

