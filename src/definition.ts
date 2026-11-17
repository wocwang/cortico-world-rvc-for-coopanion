/** WorldDefinition：装配层按 `cortico.kind === 'world'` 认这个包。 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimesRoot } from 'cortico/paths.ts';
import type { Language } from 'cortico/core/language.ts';
import { describeTools, type WorldDefinition, type WorldDescribe } from 'cortico/world.ts';
import {
  KIND_OPTIONS, RVC_DEFAULTS, RVC_ID, TIER_OPTIONS, VOICE_OPTIONS, kindOptions, tierOptions,
  type RvcConfigSection,
} from './config.ts';
import { RvcWorld } from './world.ts';
import { RVC_TOOL_DECLS } from './tools.ts';
import { listVoices } from './voices.ts';

/** 工具 `rvc_sing` 从翻唱库点歌；事件仍不发。 */
const DESCRIBE: WorldDescribe = {
  tools: describeTools(RVC_TOOL_DECLS, {
    rvc_sing: {
      zh: '从翻唱库按歌名或随机点一首，本机外放；精确命中直接播，只有相近版本时先问；默认唱法读配置，明确要另一种时再传 kind。',
      en: 'Plays a saved song from the local cover library through the speakers — by name or random; exact titles play directly, close versions are confirmed first; the default singing type comes from settings.',
    },
    rvc_find: {
      zh: '按关键词在翻唱库里找歌，空关键词列出全部；找到后把准确标题交给 rvc_sing。',
      en: 'Search the saved cover library by keywords; an empty query lists everything. Pass an exact title to rvc_sing.',
    },
    rvc_status: {
      zh: '查看当前是在播放、在后台准备，还是空闲。',
      en: 'Report whether a song is playing, a cover is being prepared, or the singer is idle.',
    },
    rvc_stop: {
      zh: '停止当前播放，并取消还在后台准备的翻唱。',
      en: 'Stop current playback and cancel a cover still being prepared.',
    },
    rvc_start: {
      zh: '启动本机 RVC 引擎并等到就绪；冷启动可能要几十秒。',
      en: 'Start the local RVC engine and wait until ready; a cold start can take tens of seconds.',
    },
    rvc_volume: {
      zh: '调整或读取播放音量 0–100；正在播放的歌会立即按新音量在原位置重开。',
      en: 'Set or read playback volume 0-100; a playing song restarts at the same position with the new volume.',
    },
  }),
  events: [{
    type: 'rvc.playback',
    description: {
      zh: '播放状态变化：后台翻唱做好开始播放、自然播完、被停止或启动失败。',
      en: 'Playback status changes: a background cover starts playing, a song finishes, playback is stopped, or it fails to start.',
    },
    trigger: 'debounce',
    tags: ['snapshot'],
  }],
};

/**
 * 扩展自己的包目录：宿主的 `ctx.packageDir` 指向加载它的 bot 包（Coopanion 里是
 * `resources/app/build/cortico/bots/<bot>`），不是这个扩展的安装目录，拿它拼 `vendor/rvc` 会指到不存在的路径。
 * 与 gpt-sovits 一样用 `import.meta.url`：这个文件就在 `<包根>/src/definition.ts`。
 */
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

/** 最近一次 create 的配置与数据目录：配置下拉的选项由框架在打开设置时现问。 */
let live: { cfg: RvcConfigSection; dataDir: string } | null = null;

function voiceOptions(language: Language): Array<{ value: string; label: string }> {
  const auto = language === 'zh' ? '自动（第一个）' : 'Auto (first)';
  let names: string[] = [];
  if (live) {
    const dir = live.cfg.voicesDir.trim() || join(live.dataDir, 'voices');
    names = listVoices(dir).map((voice) => voice.name);
  }
  return [{ value: '', label: auto }, ...names.map((name) => ({ value: name, label: name }))];
}

export const RVC: WorldDefinition<RvcConfigSection> = {
  id: RVC_ID,
  label: 'RVC唱歌-大肥鱼',
  defaults: () => structuredClone(RVC_DEFAULTS),
  configOptions(kind, language) {
    if (kind === TIER_OPTIONS) return tierOptions(language);
    if (kind === KIND_OPTIONS) return kindOptions(language);
    if (kind === VOICE_OPTIONS) return voiceOptions(language);
    return [];
  },
  // ctx.cfg 是 `worlds.rvc` 的活引用：http 开关、参数改了现读即生效
  create: (ctx) => {
    const dataDir = join(ctx.dataDir, 'rvc');
    live = { cfg: ctx.cfg, dataDir };
    return new RvcWorld({
      cfg: ctx.cfg,
      dataDir,
      packageDir: PACKAGE_DIR,
      runtimesRoot,
    });
  },
  describe: DESCRIBE,
};
