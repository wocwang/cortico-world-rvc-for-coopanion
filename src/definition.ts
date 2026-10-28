/** WorldDefinition：装配层按 `cortico.kind === 'world'` 认这个包。 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimesRoot } from 'cortico/paths.ts';
import type { WorldDefinition, WorldDescribe } from 'cortico/world.ts';
import { RVC_DEFAULTS, RVC_ID, type RvcConfigSection } from './config.ts';
import { RvcWorld } from './world.ts';

/** 本 World 不注册工具、不发事件：它只提供 HTTP 接口与面板。 */
const DESCRIBE: WorldDescribe = { tools: [], events: [] };

/**
 * 扩展自己的包目录：宿主的 `ctx.packageDir` 指向加载它的 bot 包（Coopanion 里是
 * `resources/app/build/cortico/bots/<bot>`），不是这个扩展的安装目录，拿它拼 `vendor/rvc` 会指到不存在的路径。
 * 与 gpt-sovits 一样用 `import.meta.url`：这个文件就在 `<包根>/src/definition.ts`。
 */
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

export const RVC: WorldDefinition<RvcConfigSection> = {
  id: RVC_ID,
  label: 'RVC 变声',
  defaults: () => structuredClone(RVC_DEFAULTS),
  // ctx.cfg 是 `worlds.rvc` 的活引用：http 开关、参数改了现读即生效
  create: (ctx) => new RvcWorld({
    cfg: ctx.cfg,
    dataDir: join(ctx.dataDir, 'rvc'),
    packageDir: PACKAGE_DIR,
    runtimesRoot,
  }),
  describe: DESCRIBE,
};
