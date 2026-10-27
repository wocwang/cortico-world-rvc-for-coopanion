/** WorldDefinition：装配层按 `cortico.kind === 'world'` 认这个包。 */
import { join } from 'node:path';
import { runtimesRoot } from 'cortico/paths.ts';
import type { WorldDefinition, WorldDescribe } from 'cortico/world.ts';
import { RVC_DEFAULTS, RVC_ID, type RvcConfigSection } from './config.ts';
import { RvcWorld } from './world.ts';

/** 本 World 不注册工具、不发事件：它只提供 HTTP 接口与面板。 */
const DESCRIBE: WorldDescribe = { tools: [], events: [] };

export const RVC: WorldDefinition<RvcConfigSection> = {
  id: RVC_ID,
  label: 'RVC 变声',
  defaults: () => structuredClone(RVC_DEFAULTS),
  // ctx.cfg 是 `worlds.rvc` 的活引用：http 开关、参数改了现读即生效
  create: (ctx) => new RvcWorld({
    cfg: ctx.cfg,
    dataDir: join(ctx.dataDir, 'rvc'),
    packageDir: ctx.packageDir,
    runtimesRoot,
  }),
  describe: DESCRIBE,
};
