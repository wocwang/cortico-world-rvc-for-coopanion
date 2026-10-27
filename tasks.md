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
- 包体：只带 `vendor/rvc`（40 文件 / 0.56 MB），权重运行时下载；`npm pack` 132 kB（解包 643 kB）。
- worker 改从 `assetsDir` 读权重（`rmvpe_root` + 覆盖 `infer.hubert.HUBERT_MODEL_PATH`），缺权重直接 `fatal` 快速失败。
- 测试 29 项（server 13 / install 7 / voices 9）；真实链路冒烟：`install` 报 `ready`、vendor 代码 + 数据目录权重，预热 22s，5.4s 音频 → 1.85s WAV 430KB，`vendor` 未产生 `__pycache__`。

## T3 面板

- `src/webui/client.ts`：服务状态、依赖/权重进度、音色列表、变调、索引率、保护清辅音、
  上传音频 → 试听 → 落盘、日志尾部。
- 上传走 world 内部调用 `convert`（不经 gpt-sovits）。

## T4 接回 gpt-sovits

- gpt-sovits：`config.ts` 加 `rvc.*` 六项；`http-tts.ts` 出口后处理（失败透传 + 日志限流）；
  联动页加 RVC 子卡（检测/端点/超时/变调/索引率/一键写入/试听）。
- 改前确认 gpt-sovits 工作树干净（基线 `dbb4c54` 已提交）。
- 测试：RVC 停止 / 超时 / 500 三种情况都返回原音频。

## T5 验收打包

- `typecheck` + 测试 + `build`；本机跑通「文字 → gpt-sovits → RVC → WAV」。
- 出 tgz；本地 commit（不 push、不发 release）。
- 更新 gpt-sovits CHANGELOG（联动项）与本文档勾选。

## 另册（不急）

- 飞鱼 v6 v5turbo 权重试听挑 epoch → 打包权重 release → 改 gpt-sovits catalog 版本。
- 唱歌链路（方案见 `spec.md` §11，v1 不做）：先 A1 预渲染素材包（离线生成 8–12 条 + QQ `sing` 工具）；
  确有需求再评估 A2 动态链路（旋律模型 + DiffSinger 声库 + RVC）。
