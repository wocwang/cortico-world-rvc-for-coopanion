# Tasks — RVC 变声插件

依据 `spec.md`。顺序执行，T0 不通过就停下来改路线，不先铺代码。

## T0 可行性探针（已完成，2026-10-27）

结论：通过，见 `probe.md`。要点：RVC-Project @ `81eed5e`（无 fairseq，transformers HuBERT）；
派生 venv 只补 `faiss-cpu`、`praat-parselmouth`；热态 0.27–0.33s、峰值 545–773 MB；冷启动 17s → 常驻 worker 预热。

## T1 骨架（已完成 2026-10-27）

- 新仓库 `D:\Users\HW W\Documents\pr-rvc\repo`：`package.json`（`@wocwang/cortico-world-rvc-for-coopanion`、`kind: world`、
  `cortico.api` 对齐 gpt-sovits 的 6）、`tsconfig.json`、`vitest.config.ts`、`README.md`、`LICENSE`、`describe.json`。
- `src/index.ts` / `src/world.ts`：世界生命周期、配置读取、面板注册。
- `src/server.ts`：`GET /health`、`POST /convert`（multipart）、只绑 127.0.0.1、可选 token、串行队列（上限 4）、
  错误码按 spec §6。
- `src/engine.ts`：spawn 派生 venv 的 python 跑推理脚本（子进程串行），stdin/stdout 传文件路径，读回 wav。
- 测试：队列并发=1、队列满 503、token 校验、参数校验、失败映射 502。
- 冒烟（`scripts/smoke.mts`）：预热 19.3s，5.4s 48k 输入 → 2.2s 出 40k WAV 430KB，落盘成功。

## T2 资产（已完成 2026-10-27）

- `src/catalog.ts`：hubert / rmvpe / 示例音色的 bytes + sha256 + 多源（ModelScope 自有仓库优先）。
- `src/install.ts`：下载到 `.partial` → 校验 → 改名；断点续传；进度回调。
- 用户自备 `.pth/.index` 导入（校验文件头/大小，列表可见）。
- 缺失 `tools/uvr5` 时禁用 `separator=uvr5`，面板给提示。
- 包体：只带 `vendor/rvc`（29 文件 / 0.26 MB，语言包只留 `zh_CN`/`en_US`），权重运行时下载；`npm pack` 85 kB（解包 344 kB）。
- worker 改从 `assetsDir` 读权重（`rmvpe_root` + 覆盖 `infer.hubert.HUBERT_MODEL_PATH`），缺权重直接 `fatal` 快速失败。
- 测试 29 项（server 13 / install 7 / voices 9）；真实链路冒烟：`install` 报 `ready`、vendor 代码 + 数据目录权重，预热 22s，5.4s 音频 → 1.85s WAV 430KB，`vendor` 未产生 `__pycache__`。

## T3 面板（已完成 2026-10-27）

- `src/webui/client.ts`：服务状态、依赖/权重进度、音色列表、变调、索引率、保护清辅音、
  上传音频 → 试听 → 落盘、日志尾部。
- 上传走 world 内部调用 `convert`（不经 gpt-sovits）：base64 进、`$binary` 出，落盘到 `<dataDir>/out`。
- `src/venv.ts`：派生 venv 探测/创建/补包（`faiss-cpu 1.15.1`、`praat-parselmouth 0.4.7`），
  面板「一键安装」先跑它；已有 venv 在 `start()` 后台探一次，直接显示就绪。
- 配置组改为 `webUi().config`，交给框架自带配置视图，不再各占一个面板。
- 面板 bundle 用 esbuild 打包到 `dist/`（12.2 KB JS + 0.9 KB CSS，不打 sourcemap）；整包 100 kB。
- 测试 40 项（server 13 / install 7 / voices 9 / world 7 / venv 4）。
- 真实链路：`venv=ready`、音色列表 `daifeiyu`、面板转换 430444 B WAV 落盘、随后 HTTP 转换 397 ms。

## T4 接回 gpt-sovits（已完成 2026-10-27）

- gpt-sovits：`config.ts` 加 `rvc.*` 七项（enabled / endpoint / token / timeoutMs / pitch / indexRate / protect），
  进「与其他插件联动」组，全部热改；默认 `http://127.0.0.1:9881`、超时 8000 ms。
- `src/rvc-link.ts`：出口后处理，单次 `POST /convert` 带超时；没开 / 连不上 / 超时 / 非 2xx / 不是 WAV 一律原样返回，
  失败日志同一句每分钟最多一条。
- `http-tts.ts`：新增 `post` 钩子接 `RvcLink.convert`；钩子抛错也按原音频发，链路不断。
- 联动页 RVC 子卡：检测（就绪 / 没就绪 / 连不上 / 非 2xx）、端点、超时、变调、索引率、一键写入、试听（合成 → RVC → WAV）。
- 测试 100 项（新增 rvc-link 8 / http-tts 2 / config 2）；typecheck 与面板 build 通过（30.3 KB）。
- 基线 `dbb4c54` 之上改动，仅本地 commit。

## T5 验收打包（已完成 2026-10-27）

- 两侧 `typecheck` / 测试 / `build` 全绿：gpt-sovits 100 项、本仓 40 项。
- 整链实测（`pr-gpt-sovits/repo/scripts/smoke-rvc.mts`，本机 api_v2 9880 + RVC 临时端口）：
  - 不开 RVC：48 kHz / 433,964 B，2.07 s；
  - 开 RVC：40 kHz / 360,044 B，RVC 本体 5.2 s，整句 7.3 s；
  - 中途停掉 RVC：仍 200 且是 48 kHz 原音频，日志一条「这次原样返回」。
- 出 tgz：gpt-sovits 0.5.13、本仓 0.1.0（权重不进包）；本地 commit，不 push、不发 release。

## 另册（不急）

- 飞鱼 v6 v5turbo 权重试听挑 epoch → 打包权重 release → 改 gpt-sovits catalog 版本。
- 唱歌链路（方案见 `spec.md` §11，v1 不做）：先 A1 预渲染素材包（离线生成 8–12 条 + QQ `sing` 工具）；
  确有需求再评估 A2 动态链路（旋律模型 + DiffSinger 声库 + RVC）。
