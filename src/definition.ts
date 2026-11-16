/** WorldDefinition：装配层按 `cortico.kind === 'world'` 认这个包。 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimesRoot } from 'cortico/paths.ts';
import { describeTools, type WorldDefinition, type WorldDescribe } from 'cortico/world.ts';
import { RVC_DEFAULTS, RVC_ID, TIER_OPTIONS, tierOptions, type RvcConfigSection } from './config.ts';
import { RvcWorld } from './world.ts';
import { RVC_TOOL_DECLS } from './tools.ts';

/** 工具 `rvc_sing` 从翻唱库点歌；事件仍不发。 */
const DESCRIBE: WorldDescribe = {
  tools: describeTools(RVC_TOOL_DECLS, {
    rvc_sing: {
      zh: '从翻唱库按歌名或随机点一首，本机外放；精确命中直接播，只有相近版本时先问；默认清唱，明确要翻唱 / 带伴奏才用翻唱版。',
      en: 'Plays a saved song from the local cover library through the speakers — by name or random; exact titles play directly, close versions are confirmed first; clean vocals by default, cover only when explicitly asked.',
    },
  }),
  events: [],
};

/**
 * 扩展自己的包目录：宿主的 `ctx.packageDir` 指向加载它的 bot 包（Coopanion 里是
 * `resources/app/build/cortico/bots/<bot>`），不是这个扩展的安装目录，拿它拼 `vendor/rvc` 会指到不存在的路径。
 * 与 gpt-sovits 一样用 `import.meta.url`：这个文件就在 `<包根>/src/definition.ts`。
 */
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

export const RVC: WorldDefinition<RvcConfigSection> = {
  id: RVC_ID,
  label: 'RVC唱歌-大肥鱼',
  defaults: () => structuredClone(RVC_DEFAULTS),
  configOptions(kind, language) {
    if (kind === TIER_OPTIONS) return tierOptions(language);
    return [];
  },
  // ctx.cfg 是 `worlds.rvc` 的活引用：http 开关、参数改了现读即生效
  create: (ctx) => new RvcWorld({
    cfg: ctx.cfg,
    dataDir: join(ctx.dataDir, 'rvc'),
    packageDir: PACKAGE_DIR,
    runtimesRoot,
  }),
  describe: DESCRIBE,
};
