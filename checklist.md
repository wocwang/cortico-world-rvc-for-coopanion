# Checklist — RVC 变声插件

## 决策

- [x] 串接位置 = gpt-sovits 出口调用 RVC（QQ 侧无感，失败透传）
- [x] 作用范围 = 只处理交给其他插件的音频；本机对话页不变声
- [x] RVC 面板独立入口 = 上传 →（可选）人声分离 → 变声 → 试听/落盘（走 `/convert`，不走 `/audio/speech`）
- [x] 内置音色 = 许可清晰的公开示例音色
- [x] gpt-sovits 0.5.12 基线已本地提交（`dbb4c54`，未 push）

## T0 探针（已完成 2026-10-27，见 `probe.md`）

- [x] 派生 venv（`--system-site-packages`）可用，共享运行时未被修改
- [x] `faiss-cpu` 装在 venv 内可 import（1.15.1）
- [x] ContentVec 不依赖 fairseq 能加载（transformers，上游已切换）
- [x] RMVPE 在 GPU 上加载并推理
- [x] 热态 2s 音频 0.27s、5.4s 音频 0.33s；显存峰值 545–773 MB
- [x] 选定项目与 commit：RVC-Project `81eed5e`；示例音色 `YukiKaze1337/DaFeiYu_rvc_v2_40k`（MIT）

## T1 骨架（已完成 2026-10-27）

- [x] `/health`、`/convert` 契约与 spec 一致
- [x] 串行队列（并发 1，上限 4，满则 503）
- [x] 只绑 `127.0.0.1`；token 可选
- [x] 参数校验与错误码（400/409/502/503）
- [x] 单元测试覆盖队列/校验/失败映射（12 项通过）
- [x] 真实链路冒烟：派生 venv + 常驻 worker，预热 19.3s，5.4s 音频 → 2.2s、40k 单声道 WAV

## T2 资产（已完成 2026-10-27）

- [x] hubert / rmvpe / 示例音色：bytes + sha256 + 多源 + 断点续传
- [x] 自备 `.pth` / `.index` 导入与列表（文件头 + 大小下限校验）
- [x] 缺 `tools/uvr5` 时禁用分离选项并提示
- [x] 包体：权重不进包，只带 `vendor/rvc`（0.26 MB）；`npm pack` 85 kB（解包 344 kB）
- [x] worker 从数据目录读权重，缺权重 `fatal` 快速失败
- [x] 真实链路冒烟：`install=ready`，vendor 代码 + 数据目录权重，热态 1.85s

## T3 面板（已完成 2026-10-27）

- [x] 状态 / 进度 / 音色 / 变调 / 索引率 / 保护 / 上传试听落盘 / 日志
- [x] 上传转换走世界内部调用，不经 gpt-sovits（base64 进、`$binary` 出）
- [x] 面板「一键安装」串起派生 venv + 权重，装完自动重拉引擎
- [x] 配置组交给框架配置视图；bundle 走 esbuild，整包 100 kB
- [x] 真实链路：venv=ready、面板转换 WAV 落盘、HTTP 转换 397 ms

## T4 联动（已完成 2026-10-27）

- [x] gpt-sovits `rvc.*` 配置七项（端点 / 令牌 / 超时 / 变调 / 索引率 / 保护 / 开关）
- [x] `http-tts.ts` 出口后处理：成功替换、失败/超时原样返回
- [x] 日志限流（同一错误每分钟最多一条）
- [x] 联动页 RVC 子卡（检测/端点/超时/变调/索引率/一键写入/试听）
- [x] 三种故障场景测试通过（RVC 停止 / 超时 / 500）

## T5 验收（已完成 2026-10-27）

- [x] typecheck / 测试 / build 全绿（gpt-sovits 100、本仓 40）
- [x] 「文字 → 合成 → RVC → WAV」本机跑通（48 kHz → 40 kHz，落盘可试听）
- [x] tgz + 本地 commit（不 push / 不发 release）
