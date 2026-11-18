import type { ConfigGroup } from 'cortico/core/types.ts';
import { pick, type Language } from 'cortico/core/language.ts';

export const RVC_ID = 'rvc';

/** 推理档：沿用 gpt-sovits 的口径，`auto` 检测 NVIDIA 显卡后优先 CUDA 档运行时。 */
export type RvcTier = 'auto' | 'cuda' | 'cpu';

/** 清唱 / 翻唱；与翻唱库的 `LibraryKind` 同一口径。 */
export type RvcKind = 'clean' | 'cover';

/** config.json 的 `worlds.rvc` 段。 */
export interface RvcConfigSection {
  enabled: boolean;
  /** 随 Coopanion 启动时自动拉起引擎；关掉就等面板点「启动引擎」。 */
  autoStart: boolean;
  /**
   * 闲置多少分钟后停掉引擎子进程、释放显存/内存；0 表示不停。
   * 只回收引擎，9881 接口与面板保持不变；下一条请求会自动重新拉起。
   */
  idleMinutes: number;
  /** 翻唱后保留人声/伴奏/变声结果，供面板重新混音；默认开。 */
  keepStems: boolean;
  /** 桌宠点歌默认类型：用户没明确说清唱 / 翻唱时用它。 */
  singKind: RvcKind;
  /** 面板翻唱与 B 站一键生成的默认类型。 */
  panelKind: RvcKind;
  /** 翻唱完成后默认保存到翻唱库（面板勾选框与桌宠自动生成共用）。 */
  saveToLibrary: boolean;
  /** 默认保存原声副本，方便之后原地重跑。 */
  keepSource: boolean;
  /** 唱歌时用一句短哼带动桌宠嘴型；关掉后不再为嘴型额外调 pet_say。 */
  mouthAnimation: boolean;
  /** 桌宠唱歌 / 自动播放的音量，0..100；调了会对正在播放的歌立即生效。 */
  volume: number;
  /** 翻唱会话保留天数；0 表示不按时间清理。 */
  sessionDays: number;
  /** 翻唱会话总容量上限（GB）；0 表示不按容量清理。 */
  sessionMaxGb: number;
  /**
   * 翻唱库容量上限（GB）；0 表示不限。超过只在面板提示「容量已超」，
   * 照常保存，不拒绝也不自动删除。
   */
  libraryMaxGb: number;
  /**
   * 高质量人声分离（Mel-Band RoFormer）。默认关；开启后第一次使用才下载约 871 MB 权重。
   * CUDA 不可用 / 显存不足 / 权重缺失时自动回退默认档，不阻塞翻唱。
   */
  highSeparator: boolean;
  /** 推理档；改档后重建派生 venv 并重启引擎生效。 */
  tier: RvcTier;
  /**
   * RVC 推理代码目录。空为扩展包自带的 `vendor/rvc`（只含源码，不含权重）。
   */
  codeDir: string;
  /**
   * 模型资产目录（`hubert_base/`、`rmvpe/`）。空为插件数据目录下的 `assets`。
   * 资产约 587 MB，首次使用在面板里安装（断点续传、SHA-256 校验），不随包分发。
   */
  assetsDir: string;
  /**
   * 派生 venv 里的 `python.exe`。空为插件数据目录下的 `venv\Scripts\python.exe`。
   * 派生 venv 以 gpt-sovits 运行时为 base（`--system-site-packages`），不复制整套运行时。
   */
  pythonPath: string;
  /**
   * 借用 base 解释器与 ffmpeg 的 gpt-sovits 运行时目录（含 `runtime/python.exe`）。
   * 空为在 `<部署根>/runtimes/gpt-sovits/` 下自动挑一个可用版本。
   */
  runtimeDir: string;
  /** 音色权重目录（`.pth` 与同名 `.index`）；空为插件数据目录下的 `voices`。 */
  voicesDir: string;
  /** 默认音色：`.pth` 文件名去掉扩展名。空为 `voicesDir` 里第一个。 */
  voice: string;
  /** 变调，半音，−24..24。 */
  pitch: number;
  /** 索引率（检索特征掺入比例），0..1；该音色没有 `.index` 时忽略。 */
  indexRate: number;
  /** 保护清辅音，0..0.5。 */
  protect: number;
  /** 静音门：把「本来没人声」的段压成数字静音，去掉分离残留被放大后的嘶声；默认开。 */
  silenceGate: boolean;
  /** 气声保护：模型在气声/轻声上会「编」出低频嗡鸣，这些帧换回干声；默认开。 */
  breathGuard: boolean;
  /** 对其他插件开放本机 HTTP 接口：只监听 127.0.0.1。 */
  httpApi: boolean;
  /** HTTP 接口端口；默认 9881。改端口要重挂扩展（重启 World）才生效。 */
  httpPort: number;
  /** HTTP 接口的访问令牌；留空不校验（接口只监听回环地址）。 */
  httpToken: string;
}

export const PITCH_MIN = -24;
export const PITCH_MAX = 24;
export const PROTECT_MAX = 0.5;
export const DEFAULT_PORT = 9881;
export const VOLUME_MIN = 0;
export const VOLUME_MAX = 100;

/** 播放音量归一到 0..100 的整数；非法值按 100 处理。 */
export function clampVolume(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, Math.round(number))) : 100;
}

/** 闲置分钟转毫秒：支持小数（0.5 = 30 秒），0 / 非法值表示不回收。 */
export function idleDelayMs(minutes: unknown): number {
  const value = Number(minutes);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 60_000) : 0;
}

export const RVC_DEFAULTS: RvcConfigSection = {
  enabled: false,
  autoStart: true,
  // 保持旧行为：升级后引擎照旧常驻，想要回收的用户自己开。
  idleMinutes: 0,
  // 默认开：不留分轨就没有可精修的素材；用 7 天 / 8 GB 兜住磁盘。
  keepStems: true,
  // 保持原有行为：桌宠默认清唱，面板一键翻唱默认带伴奏，训完默认入库、默认留原声。
  singKind: 'clean',
  panelKind: 'cover',
  saveToLibrary: true,
  keepSource: true,
  mouthAnimation: true,
  volume: 100,
  sessionDays: 7,
  sessionMaxGb: 8,
  libraryMaxGb: 2,
  highSeparator: false,
  tier: 'auto',
  codeDir: '',
  assetsDir: '',
  pythonPath: '',
  runtimeDir: '',
  voicesDir: '',
  voice: '',
  pitch: 0,
  indexRate: 0.3,
  protect: 0.33,
  silenceGate: true,
  breathGuard: true,
  httpApi: true,
  httpPort: DEFAULT_PORT,
  httpToken: '',
};

const K = `worlds.${RVC_ID}`;

/** `x-options` 的选项源，由定义的 `configOptions` 给出。 */
export const TIER_OPTIONS = `${RVC_ID}:tier`;
export const KIND_OPTIONS = `${RVC_ID}:kind`;
/** 默认音色下拉：选项由 `listVoices` 扫音色目录现算。 */
export const VOICE_OPTIONS = `${RVC_ID}:voice`;

const TEXT = {
  zh: {
    title: 'RVC 变声',
    groupConvert: { title: '变声参数', description: '推理档、默认音色与三个推理参数；面板上传时还可以逐次覆盖。' },
    groupDefaults: { title: '点歌与翻唱默认值', description: '桌宠点歌、面板翻唱和两个勾选项的初始值；只影响没明确指定的情况，面板里仍可逐次改。' },
    groupService: { title: '运行与接口', description: '推理代码、派生 venv 与音色目录，以及给其他插件用的本机 HTTP 接口。' },
    autoStart: { title: '随软件自动启动', description: '开启后 Coopanion 启动时就预热 RVC 引擎（约 0.7 GB 显存 / 2.5 GB 内存）；关闭后启动时不预热，但桌宠点歌、面板生成和 9881 请求仍会按需拉起。手动点「停止引擎」后不会被自动拉起。' },
    idleMinutes: { title: '闲置回收（分钟）', description: '多久没有变声/翻唱就停掉引擎子进程、释放显存与内存；支持小数，例如 0.5 = 30 秒，按秒计时。0 表示不回收（默认，保持旧行为）。只回收引擎，9881 接口照常监听，下一条请求会自动重新拉起；桌宠按需拉起的引擎也照此回收。手动点「停止引擎」后不会自动重启，也不会被桌宠拉起。' },
    keepStems: { title: '保留分轨（可精修）', description: '翻唱后把人声、伴奏和变声结果留在插件数据目录的 sessions 下，面板可以只重做混音，不用重新分离和变声。每首 4 分钟的歌约占 250 MB；默认 7 天 / 8 GB 自动清理，只清 sessions，不动 out。关闭后与旧版一样不落盘。' },
    singKind: { title: '桌宠点歌默认类型', description: '用户没明确说「清唱」或「翻唱」时，rvc_sing 用这个类型；也决定 B 站自动生成时带不带伴奏。' },
    panelKind: { title: '面板翻唱默认类型', description: '翻唱页 BGM 下拉与 B 站一键生成的初始选项；面板里仍可逐次切换。' },
    saveToLibrary: { title: '完成后默认保存到翻唱库', description: '翻唱页「完成后保存到翻唱库」的初始勾选；桌宠自动生成也按它决定是否入库。关闭后桌宠仍会播放生成结果，只是不入库。' },
    keepSource: { title: '默认保存原声副本', description: '翻唱页「保存原声副本」的初始勾选；保存后可以在「最近翻唱」里原地重跑，不必重新选文件。' },
    mouthAnimation: { title: '唱歌时让嘴型动起来', description: '开启后，提示模型在开唱后用一句短哼（如「♪～」）带动桌宠的 pet_say 气泡，嘴型会跟着动；唱完或切歌后气泡结束、嘴自然闭上。关闭后不再为嘴型额外调 pet_say。桌面宠物的嘴只跟气泡走，所以这是插件侧能做到的动画，不是逐字音频口型。' },
    volume: { title: '播放音量', description: '桌宠唱歌和自动播放的音量，0–100，默认 100。调了会对正在播放的歌立即生效：播放器会在原位置重开一下（约 0.2–0.5 秒），之后的新歌也用这个音量。面板服务页也能直接调。' },
    kindClean: '清唱（只留人声）',
    kindCover: '翻唱（带伴奏）',
    sessionDays: { title: '会话保留天数', description: '超过这么多天的翻唱会话会被清理；0 表示不按时间清理（仍受容量上限约束）。' },
    sessionMaxGb: { title: '会话容量上限（GB）', description: 'sessions 总占用超过这个值时，从最久未用的会话开始删；0 表示不限。只影响 sessions，不动 out。' },
    libraryMaxGb: { title: '翻唱库容量上限（GB）', description: '翻唱库总占用超过这个值时，面板只提示「容量已超」，仍照常保存，不拒绝也不自动删除；0 表示不限。' },
    highSeparator: { title: '高质量人声分离', description: '改用 Mel-Band RoFormer（MIT，约 871 MB）。首次开启时才下载；实测 2 分 20 秒的歌约 25 秒（比默认档更快），峰值显存约 2.1 GB；需要 CUDA 且剩余显存 ≥ 3 GB，否则自动回退默认档并提示。' },
    tier: { title: '推理档', description: '自动：检测到 NVIDIA 显卡就用显卡档，否则 CPU 档。显卡档的派生 venv 基于 CUDA 运行时，变声快很多（约 0.6–0.8 GB 显存）；CPU 档约 1–2 GB 内存。改档后在面板点「重启引擎」生效，切档会自动重建 venv。' },
    tierAuto: '自动',
    tierCuda: '显卡（NVIDIA）',
    tierCpu: 'CPU',
    voice: { title: '默认音色', description: '从音色目录里的 .pth 下拉选择；选「自动（第一个）」或留空时用目录里第一个。导入新音色后重新打开配置即可看到。同名 .index 有则自动带上。' },
    pitch: { title: '变调（半音）', description: '0 为原调；男声转女声一般 +12 左右。' },
    indexRate: { title: '索引率', description: '0..1，越高越贴近音色、但可能带出素材口音；该音色没有 .index 时忽略。' },
    protect: { title: '保护清辅音', description: '0..0.5，防止换声后齿音、吸气声被抹掉。' },
    breathGuard: { title: '气声保护（轻声不被改成低音）', description: '遇到气声、轻声、只有气息没有音高的帧，模型会自己「编」出一段低频嗡鸣，听起来像被压低喉咙唱出来。开启后这些帧换回原干声，正常演唱段不动。实测整曲约 4.5% 帧、正常段 0%。改完要重启引擎才生效；也可用 RVC_BREATH_GUARD=0 临时关闭。' },
    silenceGate: { title: '静音门（去掉嘶声）', description: '按原干声的包络，把本来没人声的段（前奏、间奏、尾音）压成数字静音。RVC 会把分离残留放大 20 dB 以上，听起来就是沙沙声；关掉则原样输出。改完要重启引擎才生效。' },
    codeDir: { title: '推理代码目录', description: 'RVC 源码目录；留空用扩展包自带的 vendor/rvc（只含代码，不含权重）。' },
    assetsDir: { title: '模型资产目录', description: 'hubert_base 与 rmvpe 所在目录；留空为插件数据目录下的 assets。约 587 MB，首次使用在面板里安装，不随包分发。' },
    pythonPath: { title: '派生 venv 的 python.exe', description: '留空为插件数据目录下的 venv\\Scripts\\python.exe。派生 venv 以 gpt-sovits 运行时为 base，不复制整套运行时。' },
    runtimeDir: { title: 'gpt-sovits 运行时目录', description: '派生 venv 的 base，也借它的 ffmpeg；留空自动挑部署里最新的一个。' },
    voicesDir: { title: '音色目录', description: '放 .pth 与同名 .index；留空为插件数据目录下的 voices。' },
    httpApi: { title: '开放本机变声接口', description: '给其他插件用：POST /convert 上传音频，拿回变声后的音频。只监听 127.0.0.1。' },
    httpPort: { title: '接口端口', description: '默认 9881；与别的程序冲突时换一个。' },
    httpToken: { title: '接口令牌', description: '留空不校验（只监听本机回环地址）。填了以后请求要带 Authorization: Bearer 或 ?token=。' },
  },
  en: {
    title: 'RVC Voice Changer',
    groupConvert: { title: 'Conversion', description: 'Inference tier, default voice and the three inference knobs; the panel can override them per upload.' },
    groupDefaults: { title: 'Singing defaults', description: 'Starting values for pet song requests, panel covers and the two checkboxes; they only apply when nothing is specified and can still be changed per run.' },
    groupService: { title: 'Runtime and API', description: 'Inference code, derived venv, voices folder, and the loopback HTTP endpoint for other plugins.' },
    autoStart: { title: 'Warm up on launch', description: 'When on, the RVC engine is warmed up when Coopanion launches (about 0.7 GB VRAM / 2.5 GB RAM). When off, it is not warmed up, but pet song requests, panel generations and 9881 requests still start it on demand. A manual Stop engine is never overridden.' },
    idleMinutes: { title: 'Idle shutdown (minutes)', description: 'Stop the engine process and free VRAM/RAM after this many idle minutes; decimals work (0.5 = 30 seconds) and the timer is accurate to the second. 0 keeps it running (default, same as before). Only the engine is recycled — the 9881 API keeps listening and the next request starts it again; an engine started by the pet is recycled the same way. A manual Stop engine is never restarted, including by the pet.' },
    keepStems: { title: 'Keep stems for refinement', description: 'After a cover, keep the separated vocals, instrumental and converted vocal under sessions in the plugin data folder, so the panel can remix without separating or converting again. About 250 MB per 4-minute song; 7 days / 8 GB auto-cleanup by default, and only sessions is touched. Off restores the old behavior (nothing kept).' },
    singKind: { title: 'Default pet singing type', description: 'Used by rvc_sing when the person does not explicitly ask for clean vocals or a cover; also decides whether Bilibili auto generation keeps the backing track.' },
    panelKind: { title: 'Default panel cover type', description: 'Starting value for the BGM selector and Bilibili one-click generation; still switchable per run in the panel.' },
    saveToLibrary: { title: 'Save finished covers to the library by default', description: 'Starting state of the "save to cover library" checkbox and whether pet auto generation is saved. When off, the pet still plays the generated result, it just is not added to the library.' },
    keepSource: { title: 'Keep the source audio by default', description: 'Starting state of the "keep source copy" checkbox; keeping it lets you rerun a cover in place from Recent covers without picking the file again.' },
    mouthAnimation: { title: 'Move the mouth while singing', description: 'On tells the model to start a short hum (for example "♪～") through a pet_say bubble when a song begins, so the pet mouth moves; after the song ends or switches, the bubble ends and the mouth closes. Off stops the extra pet_say call used only for mouth movement. The desktop pet mouth follows bubbles only, so this is plugin-side motion, not per-word audio lip sync.' },
    volume: { title: 'Playback volume', description: 'Volume for pet singing and auto-play, 0-100, default 100. Changes apply to the current song immediately by restarting it at the same position (about 0.2-0.5 s); later songs use the new volume. The Service page has the same control.' },
    kindClean: 'Clean vocals (no backing track)',
    kindCover: 'Cover (with backing track)',
    sessionDays: { title: 'Session retention (days)', description: 'Cover sessions older than this are cleaned up; 0 disables the age rule (the size cap still applies).' },
    sessionMaxGb: { title: 'Session size cap (GB)', description: 'When sessions exceed this size, the least recently used ones are removed first; 0 means no cap. Only sessions is touched, never out.' },
    libraryMaxGb: { title: 'Cover library size cap (GB)', description: 'When the cover library exceeds this size, the panel only shows an "over capacity" hint and still saves. Nothing is rejected or deleted; 0 means no cap.' },
    highSeparator: { title: 'High-quality separation', description: 'Uses Mel-Band RoFormer (MIT, about 871 MB). Downloaded only when first enabled; measured about 25 s for a 2:20 song (faster than the default tier) with a 2.1 GB VRAM peak. Needs CUDA with at least 3 GB free, otherwise the cover falls back to the default tier with a note.' },
    tier: { title: 'Inference tier', description: 'Auto uses the GPU tier when an NVIDIA GPU is detected, otherwise CPU. The GPU tier builds the derived venv on the CUDA runtime and is much faster (about 0.6–0.8 GB VRAM); the CPU tier uses about 1–2 GB RAM. After changing this, click Restart engine — switching tiers rebuilds the venv automatically.' },
    tierAuto: 'Auto',
    tierCuda: 'GPU (NVIDIA)',
    tierCpu: 'CPU',
    voice: { title: 'Default voice', description: 'Pick a .pth from the voices folder; "Auto (first)" or empty uses the first one. Reopen settings after importing a voice to see it. A matching .index is picked up automatically.' },
    pitch: { title: 'Pitch (semitones)', description: '0 keeps the original key; a male voice to female is usually around +12.' },
    indexRate: { title: 'Index rate', description: '0..1; higher sticks closer to the voice but may leak the source accent. Ignored when the voice has no .index.' },
    protect: { title: 'Protect voiceless consonants', description: '0..0.5; keeps sibilants and breaths from being smeared by the conversion.' },
    breathGuard: { title: 'Breath guard (whispers stay whispers)', description: 'On breathy or whispered frames with no clear pitch the model invents a low buzz, which sounds like being sung down an octave. With this on, those frames are replaced by the original dry vocal; normal singing is untouched (about 4.5% of frames in a full song, 0% in sung parts). Takes effect after the engine restarts; RVC_BREATH_GUARD=0 disables it.' },
    silenceGate: { title: 'Silence gate (removes hiss)', description: 'Uses the source envelope to zero out stretches where nobody is singing (intro, interludes, tails). RVC lifts separation residue by 20+ dB, which is heard as hiss; turn it off to keep the raw output. Takes effect after the engine restarts.' },
    codeDir: { title: 'Inference code folder', description: 'RVC source folder; empty uses the bundled vendor/rvc (code only, no weights).' },
    assetsDir: { title: 'Model assets folder', description: 'Where hubert_base and rmvpe live; empty uses assets under the plugin data folder. About 587 MB, installed from the panel on first use; not shipped in the package.' },
    pythonPath: { title: 'Derived venv python.exe', description: 'Empty uses venv\\Scripts\\python.exe under the plugin data folder. The venv is based on the gpt-sovits runtime instead of copying it.' },
    runtimeDir: { title: 'gpt-sovits runtime folder', description: 'Base of the derived venv and the source of ffmpeg; empty picks the newest one in the deployment.' },
    voicesDir: { title: 'Voices folder', description: 'Holds .pth files and matching .index files; empty uses voices under the plugin data folder.' },
    httpApi: { title: 'Serve the local conversion API', description: 'For other plugins: POST /convert with audio and get converted audio back. Loopback only.' },
    httpPort: { title: 'API port', description: 'Defaults to 9881; change it if something else uses that port.' },
    httpToken: { title: 'API token', description: 'Empty means no check (loopback only). When set, callers must send Authorization: Bearer or ?token=.' },
  },
};

export function configGroups(language: Language): ConfigGroup[] {
  const t = pick(language, TEXT);
  const owner = `world:${RVC_ID}`;
  return [
    {
      id: owner,
      owner,
      schema: {
        type: 'object',
        title: t.groupConvert.title,
        description: t.groupConvert.description,
        properties: {
          [`${K}.tier`]: { type: 'string', title: t.tier.title, description: t.tier.description, 'x-options': TIER_OPTIONS, 'x-hot': true },
          [`${K}.voice`]: { type: 'string', title: t.voice.title, description: t.voice.description, 'x-options': VOICE_OPTIONS, 'x-hot': true },
          [`${K}.pitch`]: { type: 'number', title: t.pitch.title, description: t.pitch.description, minimum: PITCH_MIN, maximum: PITCH_MAX, multipleOf: 1, 'x-hot': true },
          [`${K}.indexRate`]: { type: 'number', title: t.indexRate.title, description: t.indexRate.description, minimum: 0, maximum: 1, multipleOf: 0.05, 'x-hot': true },
          [`${K}.protect`]: { type: 'number', title: t.protect.title, description: t.protect.description, minimum: 0, maximum: PROTECT_MAX, multipleOf: 0.01, 'x-hot': true },
          [`${K}.silenceGate`]: { type: 'boolean', title: t.silenceGate.title, description: t.silenceGate.description, 'x-hot': true },
          [`${K}.breathGuard`]: { type: 'boolean', title: t.breathGuard.title, description: t.breathGuard.description, 'x-hot': true },
        },
      },
    },
    {
      id: `${owner}:defaults`,
      owner,
      schema: {
        type: 'object',
        title: t.groupDefaults.title,
        description: t.groupDefaults.description,
        properties: {
          [`${K}.singKind`]: { type: 'string', title: t.singKind.title, description: t.singKind.description, 'x-options': KIND_OPTIONS, 'x-hot': true },
          [`${K}.panelKind`]: { type: 'string', title: t.panelKind.title, description: t.panelKind.description, 'x-options': KIND_OPTIONS, 'x-hot': true },
          [`${K}.saveToLibrary`]: { type: 'boolean', title: t.saveToLibrary.title, description: t.saveToLibrary.description, 'x-hot': true },
          [`${K}.keepSource`]: { type: 'boolean', title: t.keepSource.title, description: t.keepSource.description, 'x-hot': true },
          [`${K}.mouthAnimation`]: { type: 'boolean', title: t.mouthAnimation.title, description: t.mouthAnimation.description, 'x-hot': true },
          [`${K}.volume`]: { type: 'number', title: t.volume.title, description: t.volume.description, minimum: VOLUME_MIN, maximum: VOLUME_MAX, multipleOf: 1, 'x-hot': true },
        },
      },
    },
    {
      id: `${owner}:service`,
      owner,
      schema: {
        type: 'object',
        title: t.groupService.title,
        description: t.groupService.description,
        properties: {
          [`${K}.autoStart`]: { type: 'boolean', title: t.autoStart.title, description: t.autoStart.description, 'x-hot': true },
          [`${K}.idleMinutes`]: { type: 'number', title: t.idleMinutes.title, description: t.idleMinutes.description, minimum: 0, maximum: 1440, 'x-hot': true },
          [`${K}.keepStems`]: { type: 'boolean', title: t.keepStems.title, description: t.keepStems.description, 'x-hot': true },
          [`${K}.sessionDays`]: { type: 'number', title: t.sessionDays.title, description: t.sessionDays.description, minimum: 0, maximum: 365, multipleOf: 1, 'x-hot': true },
          [`${K}.sessionMaxGb`]: { type: 'number', title: t.sessionMaxGb.title, description: t.sessionMaxGb.description, minimum: 0, maximum: 1000, multipleOf: 1, 'x-hot': true },
          [`${K}.libraryMaxGb`]: { type: 'number', title: t.libraryMaxGb.title, description: t.libraryMaxGb.description, minimum: 0, maximum: 1000, multipleOf: 1, 'x-hot': true },
          [`${K}.highSeparator`]: { type: 'boolean', title: t.highSeparator.title, description: t.highSeparator.description, 'x-hot': true },
          [`${K}.codeDir`]: { type: 'string', title: t.codeDir.title, description: t.codeDir.description, 'x-path': { kind: 'directory' }, 'x-hot': true },
          [`${K}.assetsDir`]: { type: 'string', title: t.assetsDir.title, description: t.assetsDir.description, 'x-path': { kind: 'directory' }, 'x-hot': true },
          [`${K}.pythonPath`]: { type: 'string', title: t.pythonPath.title, description: t.pythonPath.description, 'x-path': { kind: 'file', extensions: ['.exe'] }, 'x-hot': true },
          [`${K}.runtimeDir`]: { type: 'string', title: t.runtimeDir.title, description: t.runtimeDir.description, 'x-path': { kind: 'directory' }, 'x-hot': true },
          [`${K}.voicesDir`]: { type: 'string', title: t.voicesDir.title, description: t.voicesDir.description, 'x-path': { kind: 'directory' }, 'x-hot': true },
          [`${K}.httpApi`]: { type: 'boolean', title: t.httpApi.title, description: t.httpApi.description, 'x-hot': true },
          [`${K}.httpPort`]: { type: 'number', title: t.httpPort.title, description: t.httpPort.description, minimum: 1, maximum: 65535, multipleOf: 1, 'x-hot': true },
          [`${K}.httpToken`]: { type: 'string', title: t.httpToken.title, description: t.httpToken.description, 'x-hot': true },
        },
      },
    },
  ];
}

export function worldLabel(language: Language): string {
  return pick(language, TEXT).title;
}

/** 推理档下拉的选项；与 gpt-sovits 的「自动 / 显卡 / CPU」同一个口径。 */
export function tierOptions(language: Language): Array<{ value: RvcTier; label: string }> {
  const t = pick(language, TEXT);
  return [
    { value: 'auto', label: t.tierAuto },
    { value: 'cuda', label: t.tierCuda },
    { value: 'cpu', label: t.tierCpu },
  ];
}

/** 清唱 / 翻唱下拉的选项。 */
export function kindOptions(language: Language): Array<{ value: RvcKind; label: string }> {
  const t = pick(language, TEXT);
  return [
    { value: 'clean', label: t.kindClean },
    { value: 'cover', label: t.kindCover },
  ];
}
