# AGENTS.md — Cortico 扩展包开发规则（可复制模板）

这个目录是一个 Cortico 扩展包。在本目录里做任何事前，先读完本文件，再按第 1 节现读契约。
本文件只规定「怎么算合法」，契约本身不在这里抄一份。

## 1. 契约的唯一权威：现读，不凭记忆

优先读本机的 Cortico checkout；没有就临时 clone 一份（`git clone --depth 1
https://github.com/Pal-AI-Lab/Cortico.git`），不要凭记忆写。

| 要写的东西 | 读哪里（路径相对 Cortico checkout 根） |
|---|---|
| 包结构、manifest、安装、自描述、校验、契约版本 | `docs/extensions.md` |
| World 的事件/工具/环境提示词契约、触发档位 | `docs/worlds.md` |
| provider 的端点、方言、transport 分工 | `docs/providers.md` |
| bot 的 Persona/Memory/session 契约 | `docs/personas.md` |
| 命名约定与边界 | `AGENTS.md` §1–3 |
| 起步模板 | `templates/extension/<kind>/` 与其中的 `README.md` |
| 面板（要 WebUI 时） | `docs/webui.md`、`src/worlds/qq/webui/client.ts` |
| 命令、测试布局 | `docs/development.md` |

本机现成的 checkout：`d:\Users\HW W\Documents\pr-rvc\Cortina\state\cortico\`
（HEAD `6259042`，2026-10-29 取）。官方地址：
`https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md`。
文档与常识冲突时以文档为准，并把冲突说出来。

## 2. 硬性约束（契约之外仍然成立的部分）

1. **kind 与 api 必须匹配**：`package.json` 的 `cortico.kind` ∈ `world` / `provider` / `bot`，
   `cortico.api` 等于 `src/extensions/manifest.ts` 里 `EXTENSION_API_VERSIONS` 的对应值。
   快照（2026-10-29）：world 6、provider 6、bot 7。**每次动手前重读该文件**，不信任这里的数字。
   api 小于要求即不加载；大于要求即契约不符。
2. **命名与关键字**：包名 `cortico-world-*` / `cortico-provider-*` / `cortico-bot-*`，
   `keywords` 带 `cortico-world` / `cortico-provider` / `cortico-bot`（市场按它发现包）。
   id、前缀、工具名、事件类型按 `AGENTS.md` §2 的约定，一个 World 一套前缀。
3. **密钥不进包**：值住在部署的 `.env`，代码经 `ctx.secret(名字)` 取。交付前搜一遍包里有没有
   密钥形状的字符串。
4. **包目录只读于运行期**：不写自身目录；持久状态归部署的 Memory。
5. **改了就重跑自描述**：改过工具、事件类型或环境提示词后必须 `pnpm describe:extension <包目录>`；
   自描述过期会被 `check:extension` 判不通过。
6. **三级验证，到哪级说哪级**：
   - 一级（包内自己跑）：`pnpm typecheck && pnpm test` 绿；
   - 二级（Cortico checkout 根下自己跑）：`pnpm describe:extension <包目录>` 后
     `pnpm check:extension <包目录>` 通过（含干装载与自描述核对）；
   - 三级（只有开发者能看）：装进宿主实例，看见现象——不许用「应该能用」交付。
7. **不替开发者动他的东西**：不 `git push`、不 `npm publish`、不改他跑着的实例；
   这些只描述步骤。提交只发生在包自己的仓库里。
8. **提交规范**：Conventional Commits，`<type>(<scope>): <description>`，type 与 scope 小写英文；
   按显式路径暂存，不用 `git add -A` / `git add .` / `git commit -a`。
9. **发布前清单**：包里另有一份发布用 `AGENTS.md`（模板自带，英文），
   `cortico.tags` 取自 `https://github.com/Pal-AI-Lab/cortico-extensions` 的 `TAGS.md`，
   `CHANGELOG.md` 给要发的版本加一节 `## <版本>`，`os` 按实际平台写。

## 3. 命令（在哪跑）

| 在哪 | 命令 | 作用 |
|---|---|---|
| 包目录 | `corepack pnpm install` | 装包自己的依赖 |
| 包目录 | `pnpm typecheck && pnpm test` | 一级验证 |
| Cortico checkout 根 | `pnpm describe:extension <包目录>` | 重写 `describe.json` |
| Cortico checkout 根 | `pnpm check:extension <包目录>` | 二级验证，末两段是标签与发布清单 |

Cortico checkout 里跑脚本前需要先 `corepack pnpm install`（联网装 npm 依赖，不含模型权重）。
装不了就别宣称二级通过。

## 4. 这个文件怎么被复用

- 机制是**目录 + 文件名约定**，不需要安装、不需要全局配置：把本文件和同目录的 `CLAUDE.md`
  复制到任意插件仓库根，agent 打开那个目录就会读到。
- `CLAUDE.md` 只写一行指针 `Read AGENTS.md`；要给别的 agent 加入口，同样一行即可。
- 本文件是最小骨架：只装「目标项目特有的硬规则 + 去哪现读契约」。具体平台的用法、事件与工具
  清单写进这个包的 `spec.md` / `README.md`，不要堆回本文件。
