/**
 * RVC 变声 World：`kind = world`，只做「音频进、音频出」。
 *
 * 挂载时拉起两样东西：
 * 1. 常驻 Python worker（`src/python/worker.py`，见 engine.ts）——载入模型并预热，之后热态 0.3 秒；
 * 2. 本机 HTTP 接口（server.ts，默认 127.0.0.1:9881）——给其他插件与面板用。
 *
 * 工具 `rvc_sing` 给桌宠 / 对话页点歌：从翻唱库按歌名或随机挑一首，写进本机声卡后回执；
 * 默认清唱，只有用户明确要翻唱 / 带伴奏才用翻唱版。
 */
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import type { Language } from 'cortico/core/language.ts';
import type { Logger, ToolDef, ToolOutcome, World, WorldHost, WorldLamp, WorldWebUiDecl } from 'cortico/core/types.ts';
import { clampVolume, configGroups, DEFAULT_PORT, idleDelayMs, RVC_DEFAULTS, RVC_ID, worldLabel, type RvcConfigSection, type RvcTier } from './config.ts';
import { MELBAND_FILES, UVR_MODEL_FILE } from './catalog.ts';
import { RvcEngine, RvcError, type ConvertDone, type EngineState } from './engine.ts';
import { FileSetJob, hasFile, RvcInstaller } from './install.ts';
import { readConvertJob, startConvertServer, type ConvertDeps, type ConvertJob, type ConvertServerHandle } from './server.ts';
import { RvcVenv } from './venv.ts';
import { RuntimeInstall, installedTiers } from './runtime.ts';
import { importVoiceFile, importVoicePair, installVoiceFiles, listVoices, voiceBaseName, deleteVoice as removeVoiceFile } from './voices.ts';
import { createSession, defaultSegments, dirBytes, gcSessions, listSessions, readSession, removeSession, sessionDir, sessionsRoot, writeSession, type RefineSession } from './session.ts';
import { analyzePitch, parseF0Csv } from './pitch.ts';
import {
  cutSegment, ensureSegments, mergeSegments, muteSegment, mutedRanges, readPeaks, redoSegment,
  rerunRange, rerunSession, revertSegment, type RangeOptions,
} from './refine.ts';
import { panelText } from './webui/text.ts';
import {
  backfillDurations, defaultLibraryDir, deleteLibraryEntry, libraryStats, readLibrary, resolveLibraryFile,
  safeSongName, saveToLibrary, writeLibrary, type LibraryKind,
} from './library.ts';
import { FfplayPlayer, type SongPlayer } from './player.ts';
import { findSongs, pickSong } from './sing.ts';
import { defaultBiliClient, isBvid, pickCandidates, songTitleFromBili, type BiliClient, type BiliPick, type SearchHit } from './bili.ts';
import { RVC_TOOL_DECLS } from './tools.ts';
import { clock } from './wav.ts';

const WORKER_SCRIPT = fileURLToPath(new URL('./python/worker.py', import.meta.url));
/** 告诉模型「怎么点歌」的环境提示词模板。 */
const ENV_PROMPT_PATH = fileURLToPath(new URL('../prompts/env.md', import.meta.url));

export interface RvcWorldOptions {
  cfg: RvcConfigSection;
  dataDir: string;
  packageDir: string;
  /** `<部署根>/runtimes`；自动找 gpt-sovits 运行时用。 */
  runtimesRoot: () => string;
  /** 翻唱库根目录；默认 `<dataDir>/../../../../extensions/rvc-library`，测试可覆盖。 */
  libraryDir?: string;
  /** 建本机播放器；单测里注入假播放器用，不传就 spawn 外部 ffplay 的真播放器。 */
  createSongPlayer?: (log: Logger) => SongPlayer;
  /** B 站搜索 / 下载；单测里注入替身，不联网。 */
  bili?: BiliClient;
}

/** 在 `<runtimesRoot>/gpt-sovits/<版本>/<档>/runtime/python.exe` 里挑一个可用运行时。
 *  `auto`/`cuda` 优先 CUDA 档（auto 没有 CUDA 运行时则回退 CPU），`cpu` 只用 CPU 档。 */
export function findRuntimeDir(
  runtimesRoot: string,
  preferred: RvcTier = 'auto',
): { dir: string; tier: 'cuda' | 'cpu' } {
  const root = join(runtimesRoot, 'gpt-sovits');
  const fallback: { dir: string; tier: 'cuda' | 'cpu' } = { dir: '', tier: preferred === 'cpu' ? 'cpu' : 'cuda' };
  if (!existsSync(root)) return fallback;
  let versions: string[] = [];
  try { versions = readdirSync(root); } catch { return fallback; }
  const order: Array<'cuda' | 'cpu'> = preferred === 'cpu' ? ['cpu'] : ['cuda', 'cpu'];
  const ranked = versions.map((version) => {
    let time = 0;
    for (const tier of order) {
      try { time = Math.max(time, statSync(join(root, version, tier, 'cortico-runtime.json')).mtimeMs); } catch {
        try { time = Math.max(time, statSync(join(root, version, tier)).mtimeMs); } catch { /* 未装这一档 */ }
      }
    }
    return { version, time };
  }).sort((a, b) => b.time - a.time);
  for (const { version } of ranked) {
    for (const tier of order) {
      const dir = join(root, version, tier);
      if (existsSync(join(dir, 'runtime', 'python.exe'))) return { dir, tier };
    }
  }
  return fallback;
}

/** 音色目录里第一个 `.pth`（去掉扩展名）；没有返回空。 */
export function firstVoice(voicesDir: string): string {
  try {
    const names = readdirSync(voicesDir)
      .filter((n) => n.toLowerCase().endsWith('.pth'))
      .sort();
    return names.length ? names[0]!.slice(0, -4) : '';
  } catch {
    return '';
  }
}

/** 人声分离模型装没装：没装就把 `separator=uvr5` 与「翻唱」标成不可用。 */
export function hasUvr5(uvrDir: string): boolean {
  if (!uvrDir) return false;
  try {
    return statSync(join(uvrDir, UVR_MODEL_FILE)).size > 0;
  } catch {
    return false;
  }
}

/** 推理失败是不是内存不足（worker 堆膨胀 / 系统提交内存吃紧）。 */
export function isMemoryError(message: string): boolean {
  return /(_ArrayMemoryError|MemoryError|Unable to allocate|out of memory)/i.test(message);
}

/** 另存时交给浏览器的 MIME：按扩展名映射，未知按二进制。 */
const AUDIO_MIME: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
};

/**
 * 有没有 NVIDIA 显卡：`auto` 档要先知道装哪一档共享运行时（显卡档 4 GB，CPU 档 1 GB）。
 * 查不到就按 CPU 处理——反正装错了也只是慢，不会跑不起来。
 */
export function hasNvidia(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    execFileSync('nvidia-smi', ['-L'], { stdio: 'ignore', timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

export class RvcWorld implements World {
  readonly id = RVC_ID;
  private readonly opts: RvcWorldOptions;
  private log: Logger | null = null;
  private engine: RvcEngine | null = null;
  private installer: RvcInstaller | null = null;
  private venv: RvcVenv | null = null;
  private server: ConvertServerHandle | null = null;
  private starting: Promise<void> | null = null;
  private stopped = true;
  /** 用户在面板上手动停了引擎：自动重拉（装完依赖、切档后）都要让位给这个意图。 */
  private engineHeld = false;
  /** 引擎是「闲置回收」停的（不是用户手动停）：下一条请求要能自动拉回来。 */
  private idleStopped = false;
  private idleTimer: NodeJS.Timeout | undefined;
  /** 正在执行 stop() 的那一小段：请求要等它结束再决定是否拉回。 */
  private idleSleep: Promise<void> | undefined;
  private launchDetail = '';
  private codeDir = '';
  private assetsDir = '';
  private voicesDir = '';
  private uvrDir = '';
  /** 高质量分离权重（Mel-Band RoFormer）下载任务；默认档不需要它。 */
  private melbandJob: FileSetJob | null = null;
  private pythonPath = '';
  private runtimeDir = '';
  /** 共享运行时（gpt-sovits 的运行时包）——没有就自己下一份，三个插件共用。 */
  private runtime: RuntimeInstall | null = null;
  private runtimesRoot = '';
  /** 实际用的运行时档（`''` 表示自备运行时，判断不了）。 */
  private runtimeTier: 'cuda' | 'cpu' | '' = '';
  /** 最近一次面板转换的结果，面板渲染用。 */
  private lastConvert: { at: number; ms: number; bytes: number; savedPath: string | null; voice: string; format: string } | null = null;
  /** 最近一次「翻唱」（整首歌）的结果，面板渲染用。 */
  private lastCover: {
    at: number; ms: number; bytes: number; savedPath: string | null; voice: string; format: string;
    stages?: { separate?: number; convert?: number; mix?: number }; peakScale?: number;
    /** 这次翻唱留下的会话 id；没留分轨时为空。 */
    sessionId?: string;
    /** 实际用的分离档；`separatorNote` 是回退默认档的原因。 */
    separator?: 'mel_band' | 'mdx';
    separatorNote?: string;
    /** 勾了「完成后保存到翻唱库」并成功时的结果。 */
    library?: { id: string; title: string; kind: LibraryKind; file: string; duplicate: boolean };
    /** 勾了入库但失败的原因。 */
    libraryError?: string;
  } | null = null;
  /** 最近一次「重新混音」的结果，面板渲染用。 */
  private lastMix: { at: number; ms: number; bytes: number; savedPath: string | null; format: string; peakScale?: number } | null = null;
  /** 最近一次「重跑选段」的结果，面板渲染用。 */
  private lastRange: { at: number; ms: number; bytes: number; savedPath: string | null; format: string; start: number; end: number; pitch: number } | null = null;
  /** 最近一次「母带」的结果，面板渲染用。 */
  private lastMaster: {
    at: number; ms: number; bytes: number; savedPath: string | null; format: string;
    targetLufs: number; ceilingDb: number;
    inputLufs: number; inputTruePeakDb: number; outputLufs: number; outputTruePeakDb: number;
    gainDb: number; limitedDb: number;
  } | null = null;
  /** 当前打开/最近创建的分轨会话；清理与删除时据此保护。 */
  private activeSession: string | null = null;
  /** 翻唱库根目录（独立于会话，不随升级丢失）。 */
  private readonly libraryDir: string;
  /** 本机播放器：`rvc_sing` 把库里的歌写进它；原生模块用到才加载。 */
  private songPlayer: SongPlayer | null = null;
  /** B 站搜索 / 下载（默认走真实接口，单测注入替身）。 */
  private readonly bili: BiliClient;
  /** 点歌代次：再次点歌会自增，旧任务完成后不再抢播放条。 */
  private singGeneration = 0;
  /** 自动一键翻唱是否在跑：再次点歌时据此停引擎、让旧任务尽快结束。 */
  private autoSingBusy = false;
  /** 正在后台准备的歌名；`rvc_status` 和提示词用。 */
  private autoSingQuery = '';
  /** 当前播放；`rvc_status`、`rvc.playback` 和环境提示词都用它。 */
  private playback: {
    id: number;
    title: string;
    kind: LibraryKind;
    durationSec: number;
    startedAt: number;
  } | null = null;
  /** 播放代次：stop / 新歌会自增，旧的 onEnded 回调不再改状态。 */
  private playbackId = 0;
  /** 当前播放音量 0..100；配置默认值，桌宠/面板调了立即生效。 */
  private volume = 100;
  /** 宿主事件：播完 / 开始播放时告诉模型，不靠猜。 */
  private host: WorldHost | null = null;

  constructor(opts: RvcWorldOptions) {
    this.opts = opts;
    this.libraryDir = opts.libraryDir ?? defaultLibraryDir(opts.dataDir);
    this.bili = opts.bili ?? defaultBiliClient;
    this.volume = clampVolume(opts.cfg.volume);
  }

  envPromptVars(): Record<string, string> | null {
    const st = this.engine?.state();
    const state = st?.phase === 'ready'
      ? '就绪'
      : st?.phase === 'starting'
        ? '正在启动'
        : st?.phase === 'error'
          ? `出错：${st.detail || this.launchDetail || '未知原因'}`
          : '未启动';
    let library = '0 首';
    try {
      const entries = readLibrary(this.libraryDir).entries;
      if (entries.length) {
        const clean = entries.filter((entry) => entry.kind === 'clean').length;
        library = `${entries.length} 首（清唱 ${clean} / 翻唱 ${entries.length - clean}）`;
      }
    } catch { /* 库读不出来时按空库说 */ }
    const defaultKind = this.singKind() === 'cover' ? '翻唱（带伴奏）' : '清唱（只留人声）';
    const mouth = this.opts.cfg.mouthAnimation === false
      ? '已关闭：不要为了嘴型调用 pet_say，正常说话即可。'
      : '已开启：开唱后用 pet_say 短哼一句（如「♪～」）让嘴型动起来；不要挂长气泡，唱完或切歌后让气泡自然结束。';
    return {
      'rvc.state': state,
      'rvc.library': library,
      'rvc.defaultKind': defaultKind,
      'rvc.mouth': mouth,
      'rvc.playback': this.playbackStatus(),
      'rvc.volume': `${this.volume}%`,
    };
  }

  tools(): ToolDef[] {
    const [sing, find, status, stop, start, volume] = RVC_TOOL_DECLS;
    return [
      { ...sing!, handler: (args) => this.rvcSing(args) },
      { ...find!, handler: async (args) => this.findLibrarySongs(args) },
      { ...status!, handler: async () => this.playbackState() },
      { ...stop!, handler: () => this.stopSinging() },
      { ...start!, handler: () => this.startEngineForTool() },
      { ...volume!, handler: async (args) => this.setVolumeTool(args) },
    ];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const st = this.engine?.state();
    const t = panelText(language);
    const lamp: WorldLamp = {
      label: 'RVC',
      state: st?.phase === 'ready' ? 'online' : st?.phase === 'starting' ? 'loading' : st?.phase === 'error' ? 'error' : 'offline',
      hint: this.launchDetail || st?.detail || undefined,
    };
    return {
      label: worldLabel(language),
      lamps: [lamp],
      panels: [
        { id: 'service', title: t.serviceTitle, description: t.serviceHint, getMethods: ['state'] },
        { id: 'convert', title: t.convertTitle, description: t.convertHint, getMethods: ['state'] },
        { id: 'cover', title: t.coverTitle, description: t.coverHint, getMethods: ['state', 'refineState', 'libraryState'] },
        { id: 'voices', title: t.voicesTitle, description: t.voicesHint, getMethods: ['state', 'voices'] },
      ],
      invoke: async (panel, method, args) => this.invoke(panel, method, args),
      // 给模型的点歌写法：按歌名或随机、默认类型读配置、再点先停上一首。
      promptDocs: [{
        key: `worlds.${RVC_ID}.envPrompt`,
        title: `${worldLabel(language)} · 环境提示词`,
        description: '桌宠点歌：rvc_sing 按歌名从翻唱库取歌，省略 song 随机；不传 kind 时用配置里的默认类型，明确要另一种才传 kind。',
        path: ENV_PROMPT_PATH,
        role: 'envPrompt',
        vars: [
          { name: 'rvc.state', description: 'RVC 引擎此刻的状态（就绪 / 启动中 / 出错 / 未启动）。' },
          { name: 'rvc.library', description: '翻唱库里保存的歌曲数量与清唱 / 翻唱分布。' },
          { name: 'rvc.defaultKind', description: '配置里的桌宠点歌默认类型（清唱 / 翻唱）。' },
          { name: 'rvc.mouth', description: '唱歌时是否用 pet_say 带动嘴型（读配置里的「唱歌时让嘴型动起来」）。' },
          { name: 'rvc.playback', description: '当前播放状态：正在播 / 正在后台准备 / 没在播。' },
          { name: 'rvc.volume', description: '当前播放音量（0–100%）；rvc_volume 改的就是它。' },
        ],
      }],
      // 配置组交给框架自带的配置视图，不各占一个面板。
      config: configGroups(language),
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.log = host.log;
    this.songPlayer = this.opts.createSongPlayer
      ? this.opts.createSongPlayer(host.log)
      : new FfplayPlayer(host.log);
    this.songPlayer.setVolume(this.volume);
    this.stopped = false;
    // 「随软件自动启动」只决定启动时是否预热；桌宠 / 面板 / 9881 的按需请求仍会拉起。
    // 只有用户在服务页点「停止引擎」才记成 engineHeld，之后不自动覆盖这个意图。
    this.engineHeld = false;
    this.launchDetail = '';
    this.setup();
    // 启动时顺手清一次旧会话：只动 sessions，失败不影响启动。
    try { this.gcSessions(); } catch { /* 清理失败留到下次 */ }
    // 就绪可能要十几秒；先让 World 挂上，接口立刻能答 `ready=false`。
    if (this.opts.cfg.autoStart !== false) this.bootEngine();
    // 已有的派生 venv 不必等用户点安装：后台探一次，面板直接显示就绪。
    void this.venv?.check();
    if (this.opts.cfg.httpApi) void this.startHttp();
  }

  /** 按当前配置解析路径并（重）建 installer / venv / engine；改推理档后重启引擎会再走一遍。 */
  private setup(): void {
    const paths = this.paths();
    this.codeDir = paths.codeDir;
    this.assetsDir = paths.assetsDir;
    this.voicesDir = paths.voicesDir;
    this.uvrDir = paths.uvrDir;
    this.pythonPath = paths.pythonPath;
    this.runtimeDir = paths.runtimeDir;
    this.runtimeTier = paths.runtimeTier;
    this.runtimesRoot = paths.runtimesRoot;
    this.runtime = new RuntimeInstall({ root: paths.runtimesRoot, tier: this.wantedTier(), log: this.log ?? undefined });
    this.installer = new RvcInstaller(paths.assetsDir, paths.voicesDir, paths.uvrDir);
    this.melbandJob = new FileSetJob(paths.uvrDir, MELBAND_FILES);
    this.venv = new RvcVenv({
      pythonPath: paths.pythonPath,
      basePython: paths.runtimeDir ? join(paths.runtimeDir, 'runtime', 'python.exe') : '',
      gpu: paths.runtimeTier === 'cuda',
      log: this.log ?? undefined,
    });
    this.engine = new RvcEngine({
      pythonPath: paths.pythonPath,
      codeDir: paths.codeDir,
      voicesDir: paths.voicesDir,
      assetsDir: paths.assetsDir,
      uvrModel: join(paths.uvrDir, UVR_MODEL_FILE),
      scriptPath: WORKER_SCRIPT,
      voice: this.opts.cfg.voice.trim() || firstVoice(paths.voicesDir),
      runtimeDir: paths.runtimeDir || undefined,
      silenceGate: this.opts.cfg.silenceGate !== false,
      breathGuard: this.opts.cfg.breathGuard !== false,
      log: this.log ?? undefined,
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.singGeneration += 1;
    this.autoSingBusy = false;
    this.autoSingQuery = '';
    this.playback = null;
    this.playbackId += 1;
    this.cancelIdle();
    this.songPlayer?.close();
    this.songPlayer = null;
    this.installer?.cancel();
    this.venv?.cancel();
    const server = this.server;
    this.server = null;
    await server?.close();
    await this.engine?.stop();
    this.engine = null;
    await this.starting?.catch(() => undefined);
    this.starting = null;
    this.host = null;
  }

  /** 拉起/重拉引擎；失败原因进 `launchDetail`，面板与接口据此解释。`auto=false` 用于「重启引擎」这类明确动作。 */
  private bootEngine(auto = true): void {
    const engine = this.engine;
    if (!engine) return;
    if (auto && this.engineHeld) return;
    this.starting = engine.start()
      .then(() => {
        this.launchDetail = '';
        this.idleStopped = false;
        this.armIdle();
      })
      .catch((err: unknown) => {
        this.launchDetail = err instanceof Error ? err.message : String(err);
        this.log?.warn('RVC 引擎启动失败', { err: this.launchDetail });
      });
    void this.starting;
  }

  /** 闲置回收：到点停掉引擎子进程。手动停过（`engineHeld`）或 World 已卸载时不排期。 */
  private armIdle(): void {
    this.cancelIdle();
    const delayMs = idleDelayMs(this.opts.cfg.idleMinutes);
    if (!delayMs || this.stopped || this.engineHeld) return;
    const engine = this.engine;
    if (!engine?.ready()) return;
    if (this.job?.phase === 'working') return;
    if (engine.queue() > 0) return;
    this.idleTimer = setTimeout(() => { void this.sleepIdle(); }, delayMs);
    this.idleTimer.unref?.();
  }

  private cancelIdle(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** 定时器到点：再确认一次没有活，才真正停引擎；停完不设 `engineHeld`，下一条请求可以自动拉回。 */
  private async sleepIdle(): Promise<void> {
    this.idleTimer = undefined;
    if (this.stopped || this.engineHeld) return;
    const engine = this.engine;
    if (!engine?.ready() || engine.queue() > 0 || this.job?.phase === 'working') {
      this.armIdle();
      return;
    }
    const done = (async (): Promise<void> => {
      await engine.stop();
      this.idleStopped = true;
      this.launchDetail = '引擎已闲置停止，下一条请求会自动启动';
      this.log?.info('RVC 引擎闲置回收', { idleMinutes: this.opts.cfg.idleMinutes });
    })();
    this.idleSleep = done;
    try {
      await done;
    } finally {
      this.idleSleep = undefined;
    }
  }

  /**
   * 按需拉回：闲置回收、内存不足停掉、或启动时没预热（`autoStart=false`）都能拉起。
   * 手动停止（`engineHeld`）和上次启动失败（phase=error）保持原样，不在这里偷偷重试——
   * 前者是用户意图，后者会把真正的错误原因留给调用方。
   */
  async ensureReady(timeoutMs = 0): Promise<void> {
    if (this.stopped || this.engineHeld) return;
    const engine = this.engine;
    if (!engine || engine.ready()) return;
    // 正在执行闲置回收：等 stop() 结束（期间请求排队，不吃 409）。
    if (this.idleSleep) await this.idleSleep.catch(() => undefined);
    // 已经在启动中（自动启动或别的请求触发）：一起等，避免并发请求被 409 打回。
    if (this.starting) await this.waitStarting(timeoutMs);
    if (engine.ready()) return;
    if (engine.state().phase !== 'stopped') return;
    this.idleStopped = false;
    this.bootEngine(false);
    await this.waitStarting(timeoutMs);
  }

  /** 等引擎启动完成；`timeoutMs>0` 时超时返回错误，后台启动本身继续（下次请求可能已就绪）。 */
  private async waitStarting(timeoutMs: number): Promise<void> {
    const starting = this.starting;
    if (!starting) return;
    if (timeoutMs <= 0) {
      await starting.catch(() => undefined);
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        starting.catch(() => undefined),
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`引擎启动超过 ${Math.round(timeoutMs / 1000)} 秒`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 桌宠/接口这类调用前的「先拉起再执行」：返回可用性 + 直接可读的原因。
   * 引擎已就绪立刻返回；停止/闲置/未预热则启动并最多等 `timeoutMs`；手动停与启动失败不重试。
   */
  async ensureReadyForTool(timeoutMs = 90_000): Promise<{ ok: boolean; reason?: string }> {
    if (this.stopped) return { ok: false, reason: 'the RVC world is stopped' };
    if (this.engineHeld) return { ok: false, reason: 'the engine was stopped manually; start it on the Service page first' };
    const engine = this.engine;
    if (!engine) return { ok: false, reason: 'the RVC engine is not initialized' };
    if (engine.ready()) return { ok: true };
    let timeout = '';
    try {
      await this.ensureReady(timeoutMs);
    } catch (err) {
      timeout = err instanceof Error ? err.message : String(err);
    }
    if (engine.ready()) return { ok: true };
    const detail = engine.state().detail || this.launchDetail || timeout;
    return { ok: false, reason: detail || '引擎没有就绪' };
  }

  /** 面板/接口共用：此刻引擎状态。 */
  health(): { ready: boolean; device: string | null; model: string | null } {
    const st = this.engine?.state();
    return { ready: !!this.engine?.ready(), device: st?.device ?? null, model: st?.model ?? null };
  }

  private paths(): { codeDir: string; pythonPath: string; runtimeDir: string; runtimeTier: 'cuda' | 'cpu' | ''; voicesDir: string; assetsDir: string; uvrDir: string; runtimesRoot: string } {
    const dataDir = this.opts.dataDir;
    const runtimesRoot = this.opts.runtimesRoot();
    // 自备运行时判断不了档位；托管运行时按配置的推理档挑（auto 优先 CUDA）。
    const own = this.opts.cfg.runtimeDir.trim();
    const picked = own
      ? { dir: own, tier: '' as const }
      : findRuntimeDir(runtimesRoot, this.opts.cfg.tier);
    return {
      runtimesRoot,
      // 代码随包走（vendor/rvc，只读）；权重与音色在数据目录。
      codeDir: this.opts.cfg.codeDir.trim() || join(this.opts.packageDir, 'vendor', 'rvc'),
      assetsDir: this.opts.cfg.assetsDir.trim() || join(dataDir, 'assets'),
      pythonPath: this.opts.cfg.pythonPath.trim() || join(dataDir, 'venv', 'Scripts', 'python.exe'),
      runtimeDir: picked.dir,
      runtimeTier: picked.tier,
      voicesDir: this.opts.cfg.voicesDir.trim() || join(dataDir, 'voices'),
      // 分离模型不放 assets：那是 RVC 自己的权重目录，分离是另一个模型。
      uvrDir: join(dataDir, 'uvr5'),
    };
  }

  /** 要装哪一档运行时：显式选 CPU 就 CPU；auto / cuda 看有没有 NVIDIA（没显卡就装 CPU 档）。 */
  private wantedTier(): 'cuda' | 'cpu' {
    if (this.opts.cfg.tier === 'cpu') return 'cpu';
    return hasNvidia() ? 'cuda' : 'cpu';
  }

  private async startHttp(): Promise<void> {
    const deps: ConvertDeps = {
      ready: () => !!this.engine?.ready(),
      ensureReady: () => this.ensureReady(),
      stateText: () => this.engine?.state().detail ?? (this.launchDetail || 'RVC 引擎启动中'),
      health: () => this.health(),
      uvr5: () => hasUvr5(this.uvrDir),
      convert: (job) => this.convert(job),
      log: this.log ?? silentLogger,
    };
    try {
      const handle = await startConvertServer({
        port: this.opts.cfg.httpPort || DEFAULT_PORT,
        token: this.opts.cfg.httpToken,
        deps,
      });
      if (this.stopped) { await handle.close(); return; }
      this.server = handle;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.log?.warn('RVC 接口没能监听', { port: this.opts.cfg.httpPort, err: why });
      this.launchDetail = `接口监听失败（${this.opts.cfg.httpPort}）：${why}`;
    }
  }

  /** 一次转换：临时文件进、临时文件出；`save=1` 时另存到 `<dataDir>/out`。
   *  `separator=uvr5` 时先分离人声再变声，回的是变声后的人声（伴奏不混）。 */
  private async convert(job: ConvertJob): Promise<{ audio: Buffer; savedPath?: string }> {
    const engine = this.engine;
    if (!engine) throw new RvcError('unavailable', 'RVC 引擎未启动');
    // 闲置回收进行中/已停：等回收结束再拉回来，别在 stop() 中间硬塞转换。
    if (!engine.ready()) {
      await this.ensureReady();
      if (!engine.ready()) throw new RvcError('unavailable', engine.state().detail ?? 'RVC 引擎未就绪');
    }
    if (job.separator === 'uvr5' && !hasUvr5(this.uvrDir)) {
      throw new RvcError('param', '人声分离模型未安装；请先在服务页点「一键安装」（约 64 MB）');
    }
    const tmpDir = join(this.opts.dataDir, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const id = randomUUID();
    const ext = extname(job.filename).toLowerCase() || '.wav';
    const input = join(tmpDir, `${id}${ext}`);
    const vocals = join(tmpDir, `${id}.vocals.wav`);
    const output = join(tmpDir, `${id}.${job.format}`);
    writeFileSync(input, job.file);
    this.cancelIdle();
    const at = Date.now();
    try {
      let done;
      if (job.separator === 'uvr5') {
        await engine.separate({ input, output: vocals });
        done = await engine.convert({
          input: vocals,
          output,
          voice: job.voice,
          pitch: job.pitch,
          indexRate: job.indexRate,
          protect: job.protect,
          format: job.format,
          chunk: job.chunk,
        });
      } else {
        done = await engine.convert({
          input,
          output,
          voice: job.voice,
          pitch: job.pitch,
          indexRate: job.indexRate,
          protect: job.protect,
          format: job.format,
          chunk: job.chunk,
        });
      }
      const audio = readFileSync(output);
      let savedPath: string | undefined;
      if (job.save) {
        const outDir = join(this.opts.dataDir, 'out');
        mkdirSync(outDir, { recursive: true });
        savedPath = join(outDir, `rvc-${stamp()}.${job.format}`);
        writeFileSync(savedPath, audio);
      }
      this.lastConvert = {
        at, ms: done.ms, bytes: audio.length, savedPath: savedPath ?? null,
        voice: job.voice || engine.state().model || '', format: job.format,
      };
      return { audio, savedPath };
    } finally {
      rmSync(input, { force: true });
      rmSync(vocals, { force: true });
      rmSync(output, { force: true });
      this.armIdle();
    }
  }

  /** 面板「翻唱」：整首歌进，整首歌唱完的出声（分离 → 变声 → 混音）。 */
  private async coverFromPanel(args: unknown[]): Promise<unknown> {
    const fileName = typeof args[0] === 'string' ? args[0] : '';
    const base64 = typeof args[1] === 'string' ? args[1] : '';
    const raw = (args[2] && typeof args[2] === 'object' ? args[2] : {}) as Record<string, unknown>;
    const engine = this.engine;
    if (!engine) throw new RvcError('unavailable', 'RVC 引擎未启动');
    // 面板改成宿主文件框传路径：整首歌几十 MB，base64 进 invoke 会撞请求体上限（413）。
    const sourcePath = typeof raw.path === 'string' ? raw.path.trim() : '';
    let data: Buffer;
    let name = fileName;
    if (sourcePath) {
      try {
        if (!statSync(sourcePath).isFile()) throw new Error('不是文件');
        data = readFileSync(sourcePath);
        name = basename(sourcePath);
      } catch (err) {
        throw new RvcError('param', `读取音频失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      if (!base64) throw new RvcError('param', '缺少音频内容');
      data = Buffer.from(base64, 'base64');
    }
    if (!hasUvr5(this.uvrDir)) {
      throw new RvcError('param', '人声分离模型未安装；请先在服务页点「一键安装」（约 64 MB）');
    }
    const fields: Record<string, string> = {};
    for (const key of ['voice', 'pitch', 'indexRate', 'protect', 'format', 'chunk']) {
      const value = raw[key];
      if (value !== undefined && value !== null && value !== '') fields[key] = String(value);
    }
    let job: ConvertJob;
    try {
      job = readConvertJob({ fields, file: { filename: name || 'song.wav', data } }, { uvr5: true });
    } catch (err) {
      throw new RvcError('param', err instanceof Error ? err.message : String(err));
    }
    const vocalGain = Number(raw.vocalGain ?? 0);
    if (!Number.isFinite(vocalGain) || vocalGain < -12 || vocalGain > 12) {
      throw new RvcError('param', '人声增益必须在 -12..12 分贝');
    }
    if (!engine.ready()) {
      await this.ensureReady();
      if (!engine.ready()) throw new RvcError('unavailable', engine.state().detail ?? 'RVC 引擎未就绪');
    }

    const tmpDir = join(this.opts.dataDir, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const id = randomUUID();
    const ext = extname(fileName).toLowerCase() || '.wav';
    const withBgm = raw.withBgm !== false;
    const outFormat: 'wav' | 'mp3' = withBgm ? job.format : 'wav';
    const input = join(tmpDir, `${id}${ext}`);
    const output = join(tmpDir, `${id}.${outFormat}`);
    writeFileSync(input, job.file);
    this.cancelIdle();
    const at = Date.now();
    const keepStems = this.opts.cfg.keepStems !== false;
    const session = keepStems ? createSession(this.opts.dataDir) : null;
    if (session) this.activeSession = session.id;
    let sessionWritten = false;
    try {
      const wantHigh = this.opts.cfg.highSeparator === true;
      const melbandFile = MELBAND_FILES[0]!;
      let highReady = hasFile(this.uvrDir, melbandFile);
      let sepNote = '';
      // 选了高质量才下载权重；等待期间前台仍能看进度（state.melband）。失败就回退默认档。
      if (wantHigh && !highReady && this.melbandJob) {
        await this.melbandJob.install();
        highReady = hasFile(this.uvrDir, melbandFile);
        if (!highReady) {
          // 只回原因，前端按界面语言拼提示。
          sepNote = this.melbandJob.status().detail || 'download failed';
        }
      }
      const sepModel = wantHigh && highReady ? 'high' : 'fast';
      if (wantHigh && !highReady && !sepNote) sepNote = '高质量分离权重还没下载，这次用默认档。';
      const done = await engine.cover({
        input,
        output,
        voice: job.voice,
        pitch: job.pitch,
        indexRate: job.indexRate,
        protect: job.protect,
        format: outFormat,
        vocalGain,
        chunk: job.chunk,
        sessionDir: session?.dir,
        withBgm,
        sepModel,
        melbandModel: highReady ? join(this.uvrDir, melbandFile.path) : '',
      });
      const audio = readFileSync(output);
      const outDir = join(this.opts.dataDir, 'out');
      mkdirSync(outDir, { recursive: true });
      const savedPath = join(outDir, `${withBgm ? 'cover' : 'clean'}-${stamp()}.${outFormat}`);
      writeFileSync(savedPath, audio);
      if (session) {
        const now = new Date().toISOString();
        const rel = withBgm ? `out/mix-1.${outFormat}` : 'out/clean-1.wav';
        writeFileSync(join(session.dir, rel), audio);
        // 原声副本：勾了「保存原声副本」才复制；之后「重新翻唱」直接用它，不必再让用户选文件。
        // 写不进去不影响这次翻唱，只是菜单里会显示「原声未保存」。
        let sourceFile = '';
        if (raw.keepSource !== false) {
          try {
            sourceFile = `source${/^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '.bin'}`;
            writeFileSync(join(session.dir, sourceFile), job.file);
          } catch {
            sourceFile = '';
            this.log?.warn('写原声副本失败，本次会话不保存原声', { id: session.id });
          }
        }
        const record: RefineSession = {
          version: 1,
          id: session.id,
          createdAt: now,
          updatedAt: now,
          engine: { kind: 'rvc', voice: job.voice || engine.state().model || '', modelSampleRate: done.modelSampleRate ?? done.sampleRate ?? 0 },
          source: {
            durationSec: done.durationSec ?? 0,
            inputPeak: done.inputPeak ?? 0,
            // 原声副本保留原文件字节，格式按上传文件的扩展名记。
            format: ext.replace(/^\./, '') || 'wav',
            ...(fileName ? { name: fileName } : {}),
            ...(sourceFile ? { file: sourceFile, bytes: job.file.length } : {}),
          },
          stems: { vocals: 'stems/vocals.wav', inst: 'stems/inst.wav' },
          converted: {
            path: 'vocals/conv.wav',
            sampleRate: 44100,
            channels: 1,
            defaults: { pitch: job.pitch, indexRate: job.indexRate, protect: job.protect, chunk: job.chunk },
          },
          // 默认 20 秒网格：与 worker 切片对齐，段落边界落在既有交叉淡化接缝上。
          segments: defaultSegments(done.durationSec ?? 0, {
            pitch: job.pitch, indexRate: job.indexRate, protect: job.protect,
          }),
          mix: {
            vocalGainDb: vocalGain,
            instGainDb: 0,
            rmsRatio: done.rmsRatio ?? 1,
            rmsFrozen: true,
            fadeInSec: 0,
            fadeOutSec: 0,
            peakScale: done.peakScale ?? 1,
            withBgm,
          },
          outputs: [{ format: outFormat, path: rel, at: now, kind: withBgm ? 'cover' : 'clean' }],
        };
        writeSession(this.opts.dataDir, session.id, record);
        sessionWritten = true;
        this.gcSessions();
      }
      // 「完成后保存到翻唱库」：勾了就训完直接入库，省得再去最近翻唱里点。
      // 入库失败不影响这次成品，只把原因带回面板。
      let library: { id: string; title: string; kind: LibraryKind; file: string; duplicate: boolean } | undefined;
      let libraryError = '';
      if (raw.toLibrary === true) {
        const fallbackTitle = name.replace(/\.[a-z0-9]{1,5}$/i, '') || '未命名';
        const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : fallbackTitle;
        try {
          const result = saveToLibrary({
            root: this.libraryDir,
            kind: withBgm ? 'cover' : 'clean',
            title,
            sourcePath: savedPath,
            sessionId: session?.id,
            voice: job.voice || engine.state().model || '',
            durationSec: done.durationSec ?? 0,
            maxBytes: this.libraryMaxBytes(),
          });
          library = {
            id: result.entry.id,
            title: result.entry.title,
            kind: withBgm ? 'cover' : 'clean',
            file: result.entry.file,
            duplicate: result.duplicate,
          };
          this.log?.info('翻唱完成直接入库', { id: session?.id, kind: library.kind, title: library.title, duplicate: result.duplicate });
        } catch (err) {
          libraryError = err instanceof Error ? err.message : String(err);
          this.log?.warn('翻唱完成自动入库失败', { id: session?.id, err: libraryError });
        }
      }
      this.lastCover = {
        at, ms: done.ms, bytes: audio.length, savedPath,
        voice: job.voice || engine.state().model || '', format: outFormat,
        stages: done.stages, peakScale: done.peakScale,
        sessionId: session?.id,
        separator: done.separator ?? 'mdx',
        separatorNote: done.separatorNote ?? sepNote,
        ...(library ? { library } : {}),
        ...(libraryError ? { libraryError } : {}),
      };
      return {
        $binary: { mime: outFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav', base64: audio.toString('base64') },
        savedPath,
        ...(library ? { library } : {}),
        ...(libraryError ? { libraryError } : {}),
      };
    } finally {
      // 没写成功就清掉空会话，别在 sessions 里留垃圾。
      if (session && !sessionWritten) {
        rmSync(session.dir, { recursive: true, force: true });
        if (this.activeSession === session.id) this.activeSession = null;
      }
      rmSync(input, { force: true });
      rmSync(output, { force: true });
      this.armIdle();
    }
  }

  /** 面板「B 站搜索」：只搜不下载。低置信时把候选原样交给用户选，别硬跑几分钟。 */
  private async biliSearch(args: unknown[]): Promise<BiliPick> {
    const query = typeof args[0] === 'string' ? args[0].trim() : '';
    if (!query) throw new RvcError('param', '先填歌名');
    if (!this.biliReady()) throw new RvcError('param', '人声分离模型还没装，先去「服务」页点「一键安装」。');
    let hits: SearchHit[];
    try {
      hits = await this.bili.search(query, 20);
    } catch (err) {
      throw new RvcError('param', `B 站搜索失败：${err instanceof Error ? err.message : String(err)}`);
    }
    return pickCandidates(hits, query, 6);
  }

  /** 自动一键翻唱的前提：分离模型在位（引擎可以在后面等）。 */
  private biliReady(): boolean {
    return hasUvr5(this.uvrDir);
  }

  /**
   * 面板「B 站一键生成翻唱」：按候选顺序下载，成功后走现有按路径翻唱。
   * 勾了「完成后保存到翻唱库」就顺带入库。
   */
  private async biliCoverFromPanel(args: unknown[]): Promise<unknown> {
    const query = typeof args[0] === 'string' ? args[0].trim() : '';
    const raw = (args[1] && typeof args[1] === 'object' ? args[1] : {}) as Record<string, unknown>;
    if (!query) throw new RvcError('param', '先填歌名');
    if (!this.biliReady()) throw new RvcError('param', '人声分离模型还没装，先去「服务」页点「一键安装」。');

    let candidates = parseBiliCandidates(raw.candidates);
    if (!candidates.length) {
      const decision = await this.biliSearch([query]);
      if (!decision.confident) {
        throw new RvcError('param', `没找到足够确定的版本：${decision.reason}。请从候选里手动选一首。`);
      }
      candidates = decision.candidates;
    }

    const download = await this.downloadBiliCandidates(candidates, query);
    if (!download.source) {
      throw new RvcError('param', `B 站音频下载失败：${download.failures.slice(-1)[0] ?? '没有可用候选'}`);
    }
    try {
      const name = `${safeSongName(download.title)}.m4a`;
      return await this.coverFromPanel([name, '', {
        ...raw,
        path: download.source,
        title: download.title,
        toLibrary: raw.toLibrary === true,
      }]);
    } finally {
      rmSync(download.source, { force: true });
    }
  }

  /** 按候选顺序下载：一条失效/412 就换下一条；返回临时文件与展示名。 */
  private async downloadBiliCandidates(
    candidates: SearchHit[],
    query: string,
  ): Promise<{ source: string; title: string; failures: string[] }> {
    const tmpDir = join(this.opts.dataDir, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const failures: string[] = [];
    for (const candidate of candidates.slice(0, 5)) {
      if (!isBvid(candidate.bvid)) continue;
      const dest = join(tmpDir, `bili-${randomUUID()}.m4a`);
      try {
        const audio = await this.bili.fetch(candidate.bvid, dest, MAX_BILI_BYTES);
        const title = songTitleFromBili(audio.title || candidate.title) || songTitleFromBili(query) || query;
        return { source: dest, title, failures };
      } catch (err) {
        failures.push(`${candidate.title || candidate.bvid}: ${err instanceof Error ? err.message : String(err)}`);
        rmSync(dest, { force: true });
      }
    }
    return { source: '', title: songTitleFromBili(query) || query, failures };
  }

  /**
   * 面板「重新翻唱」：复用会话里已有的分轨，只重跑变声再重混，更新同一会话目录。
   * 不重新分离、不新建会话；段落参数 / 静音 / 成品历史 / 母带记录都保留。
   */
  private async rerunFromPanel(args: unknown[]): Promise<unknown> {
    const id = typeof args[0] === 'string' ? args[0] : '';
    const raw = (args[1] && typeof args[1] === 'object' ? args[1] : {}) as Record<string, unknown>;
    const dir = sessionDir(this.opts.dataDir, id);
    const session = dir ? readSession(this.opts.dataDir, id) : null;
    if (!dir || !session) throw new RvcError('param', `找不到会话：${id || '(空)'}`);
    for (const rel of [session.stems.vocals, session.stems.inst, session.converted.path]) {
      if (!existsSync(join(dir, rel))) {
        throw new RvcError('param', `会话缺少 ${rel}，无法原地重跑；请重新上传原声翻唱一次`);
      }
    }
    const engine = this.engine;
    if (!engine) throw new RvcError('unavailable', 'RVC 引擎未启动');
    if (!engine.ready()) {
      await this.ensureReady();
      if (!engine.ready()) throw new RvcError('unavailable', engine.state().detail ?? 'RVC 引擎未就绪');
    }

    const format = raw.format === 'mp3' ? 'mp3' : 'wav';
    let result;
    try {
      result = await rerunSession(this.opts.dataDir, engine, id, {
        pitch: raw.pitch === undefined ? undefined : Number(raw.pitch),
        indexRate: raw.indexRate === undefined ? undefined : Number(raw.indexRate),
        protect: raw.protect === undefined ? undefined : Number(raw.protect),
        chunk: raw.chunk === undefined ? undefined : raw.chunk === true || raw.chunk === 'true',
        voice: typeof raw.voice === 'string' ? raw.voice : undefined,
      });
    } catch (err) {
      if (err instanceof RvcError) throw err;
      throw new RvcError('param', err instanceof Error ? err.message : String(err));
    }
    this.activeSession = id;
    const withBgm = raw.withBgm === undefined ? result.session.mix.withBgm !== false : raw.withBgm !== false;
    const outFormat = withBgm ? format : 'wav';
    const { audio, done, path } = await this.mixSession(id, result.session, {
      format,
      vocalGainDb: clampNumber(raw.vocalGainDb, -24, 24, result.session.mix.vocalGainDb),
      instGainDb: clampNumber(raw.instGainDb, -24, 24, result.session.mix.instGainDb),
      fadeInSec: clampNumber(raw.fadeInSec, 0, 30, result.session.mix.fadeInSec),
      fadeOutSec: clampNumber(raw.fadeOutSec, 0, 30, result.session.mix.fadeOutSec),
      withBgm,
    }, true);
    this.lastCover = {
      at: Date.now(), ms: result.done.ms + done.ms, bytes: audio.length, savedPath: path,
      voice: result.session.engine.voice, format: outFormat,
      stages: { convert: result.done.ms, mix: done.ms },
      peakScale: done.peakScale,
      sessionId: id,
    };
    this.log?.info('RVC 原地重新翻唱完成', {
      id, pitch: result.session.converted.defaults.pitch, ms: result.done.ms, format: outFormat,
    });
    return { $binary: { mime: outFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav', base64: audio.toString('base64') } };
  }

  /** 面板「重新混音」：只读会话里的分轨与变声结果，重做混音后落盘，不跑模型。 */
  private async remixFromPanel(args: unknown[]): Promise<unknown> {
    const id = typeof args[0] === 'string' ? args[0] : '';
    const raw = (args[1] && typeof args[1] === 'object' ? args[1] : {}) as Record<string, unknown>;
    const dir = sessionDir(this.opts.dataDir, id);
    const session = dir ? readSession(this.opts.dataDir, id) : null;
    if (!dir || !session) throw new RvcError('param', `找不到会话：${id || '(空)'}`);
    const engine = this.engine;
    if (!engine) throw new RvcError('unavailable', 'RVC 引擎未启动');

    const format = raw.format === 'mp3' ? 'mp3' : 'wav';
    const vocalGainDb = clampNumber(raw.vocalGainDb, -24, 24, 0);
    const instGainDb = clampNumber(raw.instGainDb, -24, 24, 0);
    const fadeInSec = clampNumber(raw.fadeInSec, 0, 30, 0);
    const fadeOutSec = clampNumber(raw.fadeOutSec, 0, 30, 0);
    const withBgm = raw.withBgm === undefined ? session.mix.withBgm !== false : raw.withBgm !== false;

    if (!engine.ready()) {
      await this.ensureReady();
      if (!engine.ready()) throw new RvcError('unavailable', engine.state().detail ?? 'RVC 引擎未就绪');
    }

    const { audio, done, path } = await this.mixSession(id, session, {
      format, vocalGainDb, instGainDb, fadeInSec, fadeOutSec, withBgm,
    }, true);
    this.lastMix = {
      at: Date.now(), ms: done.ms, bytes: audio.length, savedPath: path,
      format: withBgm ? format : 'wav', peakScale: done.peakScale,
    };
    this.log?.info('RVC 重新混音完成', { id, format: withBgm ? format : 'wav', ms: done.ms });
    return { $binary: { mime: !withBgm || format === 'wav' ? 'audio/wav' : 'audio/mpeg', base64: audio.toString('base64') } };
  }

  /**
   * 用会话里的 conv + inst 混一次。`record` 为真时写成 `out/mix-<n>` 并记进
   * `session.outputs`（最多留 3 个）；为假时只写固定名 `out/preview.<fmt>` 供试听。
   */
  private async mixSession(
    id: string,
    session: RefineSession,
    opts: {
      format: 'wav' | 'mp3'; vocalGainDb: number; instGainDb: number;
      fadeInSec: number; fadeOutSec: number; withBgm: boolean;
    },
    record: boolean,
  ): Promise<{ audio: Buffer; done: ConvertDone; path: string }> {
    const dir = sessionDir(this.opts.dataDir, id);
    const engine = this.engine;
    if (!dir || !engine) throw new RvcError('unavailable', '会话或引擎不可用');
    const vocals = join(dir, session.converted.path);
    const inst = join(dir, session.stems.inst);
    if (!existsSync(vocals)) {
      throw new RvcError('param', '会话缺少人声文件，请重新翻唱一次');
    }
    if (opts.withBgm && !existsSync(inst)) {
      throw new RvcError('param', '会话缺少伴奏文件，请重新翻唱一次');
    }
    const format = opts.withBgm ? opts.format : 'wav';
    let output: string;
    let rel: string | null = null;
    if (record) {
      // 编号取已有最大值 +1：成品全部保留后，仍不会覆盖同名文件。
      const prefix = opts.withBgm ? 'mix' : 'clean';
      const next = session.outputs.reduce((max, item) => {
        const match = new RegExp(`^out/${prefix}-(\\d+)\\.`).exec(item.path);
        return match ? Math.max(max, Number(match[1])) : max;
      }, 0) + 1;
      rel = `out/${prefix}-${next}.${format}`;
      output = join(dir, rel);
    } else {
      output = join(dir, 'out', opts.withBgm ? `preview.${format}` : 'preview-clean.wav');
    }
    this.cancelIdle();
    const done = opts.withBgm ? await engine.remix({
      vocals, inst, output, format,
      vocalGain: opts.vocalGainDb, instGain: opts.instGainDb,
      fadeIn: opts.fadeInSec, fadeOut: opts.fadeOutSec,
      rmsRatio: session.mix.rmsRatio,
      mutedRanges: mutedRanges(session.segments),
    }) : await engine.vocalOnly({
      vocals, output,
      vocalGain: opts.vocalGainDb,
      fadeIn: opts.fadeInSec, fadeOut: opts.fadeOutSec,
      rmsRatio: session.mix.rmsRatio,
      mutedRanges: mutedRanges(session.segments),
    });
    const audio = readFileSync(output);
    if (record && rel) {
      session.mix = {
        ...session.mix,
        vocalGainDb: opts.vocalGainDb, instGainDb: opts.instGainDb,
        fadeInSec: opts.fadeInSec, fadeOutSec: opts.fadeOutSec,
        peakScale: done.peakScale ?? 1, withBgm: opts.withBgm,
      };
      session.updatedAt = new Date().toISOString();
      session.outputs.push({
        format, path: rel, at: session.updatedAt,
        kind: opts.withBgm ? 'cover' : 'clean',
      });
      // 成品全部保留：面板「结果编辑」要能对任意一条重混/对比，不再只留最近 3 条。
      // 磁盘占用跟着会话目录，删会话时一并清掉。
      writeSession(this.opts.dataDir, id, session);
    }
    this.activeSession = id;
    return { audio, done, path: output };
  }

  /** 面板「重跑这一段」：只重渲选区拼回 conv，再按当前混音参数出一条成品。 */
  private async rangeFromPanel(args: unknown[]): Promise<unknown> {
    const id = typeof args[0] === 'string' ? args[0] : '';
    const raw = (args[1] && typeof args[1] === 'object' ? args[1] : {}) as Record<string, unknown>;
    const engine = this.engine;
    if (!engine) throw new RvcError('unavailable', 'RVC 引擎未启动');
    if (!engine.ready()) {
      await this.ensureReady();
      if (!engine.ready()) throw new RvcError('unavailable', engine.state().detail ?? 'RVC 引擎未就绪');
    }
    const format = raw.format === 'mp3' ? 'mp3' : 'wav';
    const options: RangeOptions = {
      startSec: Number(raw.startSec),
      endSec: Number(raw.endSec),
      pitch: raw.pitch === undefined ? undefined : Number(raw.pitch),
      indexRate: raw.indexRate === undefined ? undefined : Number(raw.indexRate),
      protect: raw.protect === undefined ? undefined : Number(raw.protect),
    };
    let result;
    try {
      result = await rerunRange(this.opts.dataDir, engine, id, options);
    } catch (err) {
      if (err instanceof RvcError) throw err;
      throw new RvcError('param', err instanceof Error ? err.message : String(err));
    }
    this.log?.info('RVC 选段重跑完成', {
      id, start: result.segment.start, end: result.segment.end,
      ms: result.done.ms, peakFactor: result.done.peakFactor,
    });
    this.activeSession = id;
    const withBgm = result.session.mix.withBgm !== false;
    const outFormat = withBgm ? format : 'wav';
    const { audio, done, path } = await this.mixSession(id, result.session, {
      format,
      vocalGainDb: result.session.mix.vocalGainDb,
      instGainDb: result.session.mix.instGainDb,
      fadeInSec: result.session.mix.fadeInSec,
      fadeOutSec: result.session.mix.fadeOutSec,
      withBgm,
    }, true);
    this.lastRange = {
      at: Date.now(), ms: result.done.ms + done.ms, bytes: audio.length, savedPath: path,
      format: outFormat, start: result.segment.start, end: result.segment.end, pitch: result.segment.params.pitch,
    };
    return { $binary: { mime: outFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav', base64: audio.toString('base64') } };
  }

  /** 面板「试听这段」：按当前滑杆参数出一条临时成品，不写 outputs、不改会话。 */
  private async previewSession(id: string, raw: Record<string, unknown>): Promise<unknown> {
    const dir = sessionDir(this.opts.dataDir, id);
    const session = dir ? readSession(this.opts.dataDir, id) : null;
    if (!dir || !session) throw new RvcError('param', `找不到会话：${id || '(空)'}`);
    const engine = this.engine;
    if (!engine) throw new RvcError('unavailable', 'RVC 引擎未启动');
    if (!engine.ready()) {
      await this.ensureReady();
      if (!engine.ready()) throw new RvcError('unavailable', engine.state().detail ?? 'RVC 引擎未就绪');
    }
    const format = raw.format === 'mp3' ? 'mp3' : 'wav';
    const withBgm = raw.withBgm === undefined ? session.mix.withBgm !== false : raw.withBgm !== false;
    const { audio } = await this.mixSession(id, session, {
      format,
      vocalGainDb: clampNumber(raw.vocalGainDb, -24, 24, session.mix.vocalGainDb),
      instGainDb: clampNumber(raw.instGainDb, -24, 24, session.mix.instGainDb),
      fadeInSec: clampNumber(raw.fadeInSec, 0, 30, session.mix.fadeInSec),
      fadeOutSec: clampNumber(raw.fadeOutSec, 0, 30, session.mix.fadeOutSec),
      withBgm,
    }, false);
    return {
      $binary: {
        mime: !withBgm || format === 'wav' ? 'audio/wav' : 'audio/mpeg',
        base64: audio.toString('base64'),
      },
    };
  }

  /** 面板「导出音高」：对分离人声提一次 RMVPE，写 out/f0.csv，内容直接交给面板下载。 */
  private async f0FromPanel(id: string): Promise<Record<string, unknown>> {
    const dir = sessionDir(this.opts.dataDir, id);
    const session = dir ? readSession(this.opts.dataDir, id) : null;
    if (!dir || !session) throw new RvcError('param', `找不到会话：${id || '(空)'}`);
    const engine = this.engine;
    if (!engine) throw new RvcError('unavailable', 'RVC 引擎未启动');
    if (!engine.ready()) {
      await this.ensureReady();
      if (!engine.ready()) throw new RvcError('unavailable', engine.state().detail ?? 'RVC 引擎未就绪');
    }
    const target = join(dir, 'out', 'f0.csv');
    let done: Awaited<ReturnType<RvcEngine['f0']>>;
    try {
      done = await engine.f0({ input: join(dir, session.stems.vocals), output: target });
    } catch (err) {
      if (err instanceof RvcError) throw err;
      throw new RvcError('infer', err instanceof Error ? err.message : String(err));
    }
    const csv = readFileSync(target, 'utf8');
    this.log?.info('RVC 音高曲线已导出', { id, frames: done.frames, ms: done.ms });
    return {
      name: 'f0.csv', csv, frames: done.frames, frameRate: done.frameRate,
      durationSec: done.durationSec, savedPath: target,
    };
  }

  /**
   * 面板「一键母带」：以最近一条成品为源，按 -14 / -16 / -23 LUFS 另存一条。
   * 不覆盖任何已有文件；`session.masters` 只追加，最多留 3 条。
   */
  private async masterFromPanel(args: unknown[]): Promise<unknown> {
    const id = typeof args[0] === 'string' ? args[0] : '';
    const raw = (args[1] && typeof args[1] === 'object' ? args[1] : {}) as Record<string, unknown>;
    const dir = sessionDir(this.opts.dataDir, id);
    const session = dir ? readSession(this.opts.dataDir, id) : null;
    if (!dir || !session) throw new RvcError('param', `找不到会话：${id || '(空)'}`);
    const engine = this.engine;
    if (!engine) throw new RvcError('unavailable', 'RVC 引擎未启动');
    const targetLufs = Number(raw.targetLufs);
    if (![-14, -16, -23].includes(targetLufs)) {
      throw new RvcError('param', '母带只支持 -14 / -16 / -23 LUFS 三档');
    }
    const format = raw.format === 'mp3' ? 'mp3' : 'wav';
    const source = session.outputs[session.outputs.length - 1];
    if (!source) throw new RvcError('param', '这个会话还没有成品，先混一次再母带');
    const input = join(dir, source.path);
    if (!existsSync(input)) throw new RvcError('param', '最近一次成品文件不在了，请重新混音');

    if (!engine.ready()) {
      await this.ensureReady();
      if (!engine.ready()) throw new RvcError('unavailable', engine.state().detail ?? 'RVC 引擎未就绪');
    }

    // 编号取已有最大值 +1：母带全部保留后，也不会覆盖同名文件。
    const next = (session.masters ?? []).reduce((max, item) => {
      const match = /^out\/master-(\d+)\./.exec(item.path);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1;
    const rel = `out/master-${next}.${format}`;
    const output = join(dir, rel);
    this.cancelIdle();
    let done;
    try {
      done = await engine.master({ input, output, format, targetLufs, ceilingDb: -1 });
    } catch (err) {
      if (err instanceof RvcError) throw err;
      throw new RvcError('infer', err instanceof Error ? err.message : String(err));
    }
    const audio = readFileSync(output);
    const now = new Date().toISOString();
    session.masters = [...(session.masters ?? []), { format, path: rel, at: now, ...done.loudness }];
    // 母带也全部保留，供结果编辑里逐条对比。
    session.updatedAt = now;
    writeSession(this.opts.dataDir, id, session);
    this.activeSession = id;
    this.lastMaster = {
      at: Date.now(), ms: done.ms, bytes: audio.length, savedPath: output, format,
      ...done.loudness,
    };
    this.log?.info('RVC 母带完成', { id, targetLufs, outputLufs: done.loudness.outputLufs, ms: done.ms });
    return { $binary: { mime: format === 'mp3' ? 'audio/mpeg' : 'audio/wav', base64: audio.toString('base64') } };
  }

  /**
   * 面板「音高体检」：复用 `out/f0.csv`（没有或比分轨旧才重跑 RMVPE），
   * 返回叠加曲线与跑调区间。只读，不改 conv、不改 f0。
   */
  private async pitchFromPanel(id: string): Promise<Record<string, unknown>> {
    const dir = sessionDir(this.opts.dataDir, id);
    const session = dir ? readSession(this.opts.dataDir, id) : null;
    if (!dir || !session) throw new RvcError('param', `找不到会话：${id || '(空)'}`);
    const stem = join(dir, session.stems.vocals);
    if (!existsSync(stem)) throw new RvcError('param', '会话缺少人声分轨，请重新翻唱一次');
    const csv = join(dir, 'out', 'f0.csv');
    let cached = false;
    try {
      cached = existsSync(csv) && statSync(csv).mtimeMs >= statSync(stem).mtimeMs;
    } catch {
      cached = false;
    }
    if (!cached) {
      const engine = this.engine;
      if (!engine) throw new RvcError('unavailable', 'RVC 引擎未启动');
      if (!engine.ready()) {
        await this.ensureReady();
        if (!engine.ready()) throw new RvcError('unavailable', engine.state().detail ?? 'RVC 引擎未就绪');
      }
      try {
        await engine.f0({ input: stem, output: csv });
      } catch (err) {
        if (err instanceof RvcError) throw err;
        throw new RvcError('infer', err instanceof Error ? err.message : String(err));
      }
    }
    const analysis = analyzePitch(parseF0Csv(readFileSync(csv, 'utf8')), 100);
    this.log?.info('RVC 音高体检完成', {
      id, frames: analysis.frames, cached, regions: analysis.regionCount, inTune: analysis.inTuneRatio,
    });
    return { ...analysis, cached, savedPath: csv };
  }

  /**
   * 面板 A/B：按 `session.outputs` / `session.masters` 下标把成品交给浏览器
   * （`$file` 由宿主校验并流式返回，不在 JSON 里塞 base64）。只允许读本会话已登记的文件。
   */
  private audioFromPanel(args: unknown[]): Record<string, unknown> {
    const id = typeof args[0] === 'string' ? args[0] : '';
    const index = Number(args[1]);
    const kind = args[2] === 'master' ? 'master' : 'output';
    const dir = sessionDir(this.opts.dataDir, id);
    const session = dir ? readSession(this.opts.dataDir, id) : null;
    if (!dir || !session) throw new RvcError('param', `找不到会话：${id || '(空)'}`);
    const list = kind === 'master' ? session.masters ?? [] : session.outputs;
    const output = Number.isInteger(index) ? list[index] : undefined;
    if (!output) throw new RvcError('param', `成品序号无效：${String(args[1] ?? '')}`);
    const full = join(dir, output.path);
    if (!existsSync(full)) throw new RvcError('param', '成品文件不存在，可能已被清理');
    const data = readFileSync(full);
    return {
      $file: {
        mime: output.format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
        path: full,
        bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      },
    };
  }

  private async peaksFromPanel(id: string): Promise<unknown> {
    const engine = this.engine;
    if (!engine) throw new RvcError('unavailable', 'RVC 引擎未启动');
    if (!engine.ready()) {
      await this.ensureReady();
      if (!engine.ready()) throw new RvcError('unavailable', engine.state().detail ?? 'RVC 引擎未就绪');
    }
    try {
      return await readPeaks(this.opts.dataDir, engine, id);
    } catch (err) {
      if (err instanceof RvcError) throw err;
      throw new RvcError('param', err instanceof Error ? err.message : String(err));
    }
  }

  /** 面板「重做/还原段落」：都跑一次模型并混出新成品，只是音频来源不同。 */
  private async segmentFromPanel(args: unknown[], mode: 'redo' | 'revert'): Promise<unknown> {
    const id = typeof args[0] === 'string' ? args[0] : '';
    const raw = (args[1] && typeof args[1] === 'object' ? args[1] : {}) as Record<string, unknown>;
    const segmentId = typeof raw.segmentId === 'string' ? raw.segmentId : '';
    const engine = this.engine;
    if (!engine) throw new RvcError('unavailable', 'RVC 引擎未启动');
    if (!engine.ready()) {
      await this.ensureReady();
      if (!engine.ready()) throw new RvcError('unavailable', engine.state().detail ?? 'RVC 引擎未就绪');
    }
    const format = raw.format === 'mp3' ? 'mp3' : 'wav';
    let session: RefineSession;
    let segment;
    let modelMs = 0;
    try {
      if (mode === 'redo') {
        const result = await redoSegment(this.opts.dataDir, engine, id, segmentId, {
          pitch: raw.pitch === undefined ? undefined : Number(raw.pitch),
          indexRate: raw.indexRate === undefined ? undefined : Number(raw.indexRate),
          protect: raw.protect === undefined ? undefined : Number(raw.protect),
        });
        session = result.session;
        segment = result.segment;
        modelMs = result.done.ms;
      } else {
        const result = await revertSegment(this.opts.dataDir, engine, id, segmentId);
        session = result.session;
        segment = result.segment;
      }
    } catch (err) {
      if (err instanceof RvcError) throw err;
      throw new RvcError('param', err instanceof Error ? err.message : String(err));
    }
    this.activeSession = id;
    const { audio, done, path } = await this.mixSession(id, session, {
      format,
      vocalGainDb: session.mix.vocalGainDb,
      instGainDb: session.mix.instGainDb,
      fadeInSec: session.mix.fadeInSec,
      fadeOutSec: session.mix.fadeOutSec,
      withBgm: session.mix.withBgm !== false,
    }, true);
    this.lastRange = {
      at: Date.now(), ms: modelMs + done.ms, bytes: audio.length, savedPath: path,
      format, start: segment.start, end: segment.end, pitch: segment.params.pitch,
    };
    this.log?.info(mode === 'redo' ? 'RVC 段落重做完成' : 'RVC 段落还原完成', {
      id, segment: segment.id, ms: modelMs,
    });
    return { $binary: { mime: format === 'mp3' ? 'audio/mpeg' : 'audio/wav', base64: audio.toString('base64') } };
  }

  /** 段落级元数据操作（静音/切分/合并）：只改 session.json，不碰音频。 */
  private segmentEdit(method: string, args: unknown[]): Record<string, unknown> {
    const id = typeof args[0] === 'string' ? args[0] : '';
    const raw = (args[1] && typeof args[1] === 'object' ? args[1] : {}) as Record<string, unknown>;
    const segmentId = typeof raw.segmentId === 'string' ? raw.segmentId : '';
    try {
      if (method === 'segmentMute') muteSegment(this.opts.dataDir, id, segmentId, Boolean(raw.muted));
      else if (method === 'segmentCut') cutSegment(this.opts.dataDir, id, segmentId, Number(raw.atSec));
      else mergeSegments(this.opts.dataDir, id, segmentId);
    } catch (err) {
      if (err instanceof RvcError) throw err;
      throw new RvcError('param', err instanceof Error ? err.message : String(err));
    }
    this.activeSession = id || this.activeSession;
    return this.refineState(id);
  }

  /**
   * 面板「结果编辑」：会话列表 + 当前会话的混音参数。
   * `files` 把成品（混音 + 母带）按时间排成一份清单，面板据此做成品选择。
   */
  private refineState(id = '', listOnly = false): Record<string, unknown> {
    const sessions = listSessions(this.opts.dataDir);
    const has = (value: string): boolean => sessions.some((s) => s.id === value);
    const wanted = listOnly
      ? ''
      : id && has(id)
        ? id
        : this.activeSession && has(this.activeSession) ? this.activeSession : sessions[0]?.id ?? '';
    // 面板选中的会话就是「正在用的」：清理时跳过它，避免刚调好参数就被删。
    this.activeSession = wanted || null;
    const session = wanted ? readSession(this.opts.dataDir, wanted) : null;
    // 老会话（P1 只存过 range 记录）在这里补一次段落网格；写失败不影响展示。
    if (session && ensureSegments(session)) {
      try { writeSession(this.opts.dataDir, wanted, session); } catch { /* 只读展示 */ }
    }
    return {
      root: sessionsRoot(this.opts.dataDir),
      keep: this.opts.cfg.keepStems !== false,
      days: this.opts.cfg.sessionDays,
      maxGb: this.opts.cfg.sessionMaxGb,
      active: this.activeSession,
      sessions,
      session,
      files: session && wanted ? this.outputFiles(wanted, session) : [],
    };
  }

  /** 成品清单：混音与母带合在一起按时间升序；`index` 是各自数组里的下标。 */
  private outputFiles(id: string, session: RefineSession): Array<{
    kind: 'output' | 'master';
    index: number;
    format: string;
    path: string;
    at: string;
    bytes: number;
    mediaKind?: 'cover' | 'clean';
    targetLufs?: number;
  }> {
    const dir = sessionDir(this.opts.dataDir, id);
    if (!dir) return [];
    const size = (rel: string): number => {
      const full = join(dir, rel);
      try { return existsSync(full) ? statSync(full).size : 0; } catch { return 0; }
    };
    const files = [
      ...session.outputs.map((item, index) => ({
        kind: 'output' as const, index, format: item.format, path: item.path, at: item.at, bytes: size(item.path),
        mediaKind: item.kind,
      })),
      ...(session.masters ?? []).map((item, index) => ({
        kind: 'master' as const, index, format: item.format, path: item.path, at: item.at,
        bytes: size(item.path), targetLufs: item.targetLufs,
        // 母带跟随会话当前的成品类型，清唱会话的母带不该标成翻唱。
        mediaKind: (session.mix.withBgm === false ? 'clean' : 'cover') as 'clean' | 'cover',
      })),
    ];
    files.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.path.localeCompare(b.path));
    return files;
  }

  /** 保存一份会话成品到翻唱库；面板把歌名/类型传进来，文件复制在后端完成。 */
  private librarySave(args: unknown[]): Record<string, unknown> {
    const id = typeof args[0] === 'string' ? args[0] : '';
    const media = args[1] === 'master' ? 'master' : 'output';
    const index = Number(args[2]);
    const libraryKind: LibraryKind = args[3] === 'clean' ? 'clean' : 'cover';
    const titleArg = typeof args[4] === 'string' ? args[4].trim() : '';
    const dir = sessionDir(this.opts.dataDir, id);
    const session = dir ? readSession(this.opts.dataDir, id) : null;
    if (!dir || !session) throw new RvcError('param', `找不到会话：${id || '(空)'}`);
    const list = media === 'master' ? session.masters ?? [] : session.outputs;
    // 面板传 -1 表示「最近一条」，老版本没传序号时也按最近一条兜底。
    const item = Number.isInteger(index) && index >= 0 ? list[index] : list[list.length - 1];
    if (!item) throw new RvcError('param', media === 'master' ? '这个会话还没有母带' : '这个会话还没有成品');
    const source = join(dir, item.path);
    if (!existsSync(source)) throw new RvcError('param', `文件不在了：${item.path}`);
    const ext = extname(item.path).toLowerCase();
    if (libraryKind === 'clean' && ext !== '.wav') {
      throw new RvcError('param', '清唱入库需要 WAV 格式，请先生成清唱版');
    }
    const fallback = session.source.name ? session.source.name.replace(/\.[a-z0-9]{1,5}$/i, '') : '未命名';
    const title = titleArg || fallback;
    try {
      const result = saveToLibrary({
        root: this.libraryDir,
        kind: libraryKind,
        title,
        sourcePath: source,
        sessionId: id,
        voice: session.engine.voice,
        mastered: media === 'master',
        durationSec: session.source.durationSec,
        maxBytes: this.libraryMaxBytes(),
      });
      this.log?.info('保存到 RVC 翻唱库', { id, kind: libraryKind, title, duplicate: result.duplicate });
      return { ...result };
    } catch (err) {
      throw new RvcError('param', err instanceof Error ? err.message : String(err));
    }
  }

  private libraryState(): Record<string, unknown> {
    const index = readLibrary(this.libraryDir);
    // 配置是上限的唯一来源：旧索引/旧配置缺字段时按 2 GB 兜底，0 表示不限。
    index.maxBytes = this.libraryMaxBytes();
    // 老索引没有时长：从 WAV 头补一次并写回，面板列表不用每次再算。
    if (backfillDurations(this.libraryDir, index)) writeLibrary(this.libraryDir, index);
    return {
      ...libraryStats(this.libraryDir, index),
      entries: index.entries.map(({ sourceHash: _hash, ...item }) => item),
    };
  }

  /** 翻唱库上限（字节）：配置页与面板同一份 `libraryMaxGb`；0 表示不限。 */
  private libraryMaxBytes(): number {
    const raw = this.opts.cfg.libraryMaxGb;
    const gb = raw === undefined || raw === null ? RVC_DEFAULTS.libraryMaxGb : Number(raw);
    if (!Number.isFinite(gb) || gb <= 0) return 0;
    return Math.round(gb * 1024 * 1024 * 1024);
  }

  /** 列出某个会话的全部成品（混音 + 母带），保存到库时选版本用；不改当前会话。 */
  private sessionFiles(id: string): { files: unknown[] } {
    const dir = sessionDir(this.opts.dataDir, id);
    const session = dir ? readSession(this.opts.dataDir, id) : null;
    if (!dir || !session) throw new RvcError('param', `找不到会话：${id || '(空)'}`);
    return { files: this.outputFiles(id, session) };
  }

  /** 试听：把库里的文件交给浏览器流式读取（`$file`），不用 base64 塞整首；sha256 边读边算。 */
  private async libraryFile(id: string): Promise<Record<string, unknown>> {
    const entry = resolveLibraryFile(this.libraryDir, id);
    const ext = extname(entry.fullPath).toLowerCase() || '.wav';
    const bytes = statSync(entry.fullPath).size;
    const sha256 = await new Promise<string>((resolve, reject) => {
      const hash = createHash('sha256');
      createReadStream(entry.fullPath)
        .on('data', (chunk) => { hash.update(chunk); })
        .on('end', () => resolve(hash.digest('hex')))
        .on('error', reject);
    });
    return {
      $file: {
        mime: AUDIO_MIME[ext] ?? 'application/octet-stream',
        path: entry.fullPath,
        bytes,
        sha256,
      },
    };
  }

  /**
   * 打开库所在文件夹（Windows 资源管理器；不新增 HTTP 路由）。
   *
   * 之前用 `execFile('explorer.exe', …)` 且把回调里的错误吞了：宿主进程的 PATH 被裁过或
   * 资源管理器启动失败时，面板只会显示「已打开」，实际什么都不发生。这里改用
   * `%SystemRoot%\explorer.exe` 的绝对路径，并把 spawn 失败抛回面板。
   */
  private libraryOpen(): Promise<{ dir: string }> {
    mkdirSync(this.libraryDir, { recursive: true });
    const dir = this.libraryDir;
    if (process.platform !== 'win32') {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      return new Promise((resolve, reject) => {
        execFile(opener, [dir], (err) => {
          if (err) reject(new RvcError('param', `打开文件夹失败：${err.message}`));
          else resolve({ dir });
        });
      });
    }
    const explorer = join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'explorer.exe');
    if (!existsSync(explorer)) throw new RvcError('param', `找不到资源管理器：${explorer}`);
    return new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(explorer, [dir], { detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', (err) => {
        if (!settled) {
          settled = true;
          reject(new RvcError('param', `打开资源管理器失败：${err.message}`));
        } else {
          this.log?.warn('打开翻唱库后资源管理器报错', { err: err.message });
        }
      });
      child.once('spawn', () => {
        settled = true;
        child.unref();
        this.log?.info('打开翻唱库', { dir });
        resolve({ dir });
      });
    });
  }

  /** 开始下载高质量分离权重（面板切到高质量时调用）；进度走 state.melband。 */
  private downloadSeparator(): Record<string, unknown> {
    void this.melbandJob?.install();
    return this.status();
  }

  private cancelSeparator(): Record<string, unknown> {
    this.melbandJob?.cancel();
    return this.status();
  }

  /** 卸载高质量分离权重（只删 Mel-Band，不动默认 Inst_HQ_3）。 */
  private removeSeparator(): Record<string, unknown> {
    if (this.melbandJob?.status().phase === 'working') {
      throw new RvcError('param', '正在下载高质量分离权重，先点「取消」再卸载');
    }
    for (const file of MELBAND_FILES) {
      for (const target of [join(this.uvrDir, file.path), join(this.uvrDir, `${file.path}.partial`)]) {
        if (existsSync(target)) rmSync(target, { force: true });
      }
    }
    this.log?.info('卸载高质量分离权重', { dir: this.uvrDir });
    return this.status();
  }

  private libraryDelete(id: string): Record<string, unknown> {
    try {
      deleteLibraryEntry(this.libraryDir, id);
      return this.libraryState();
    } catch (err) {
      throw new RvcError('param', err instanceof Error ? err.message : String(err));
    }
  }

  /** 播放状态给模型看：正在播 / 正在准备 / 没在播，避免它靠猜。 */
  private playbackStatus(): string {
    const current = this.playback;
    if (current) {
      const elapsed = Math.max(0, Math.floor((Date.now() - current.startedAt) / 1000));
      const total = current.durationSec > 0 ? ` of ${clock(current.durationSec)}` : '';
      const label = current.kind === 'clean' ? 'clean vocal' : 'cover';
      return `currently playing "${current.title}" (${label}), ${clock(elapsed)}${total} elapsed`;
    }
    if (this.autoSingBusy) {
      return `preparing "${this.autoSingQuery || 'a song'}" in the background; nothing is playing yet`;
    }
    return 'nothing is playing';
  }

  /** 只在有宿主事件能力时投递；单测的假宿主没有 pushEvent，直接跳过。 */
  private pushPlayback(text: string, trigger: 'debounce' | 'piggyback'): void {
    const host = this.host;
    if (!host || typeof host.pushEvent !== 'function') return;
    void host.pushEvent({
      type: 'rvc.playback',
      source: RVC_ID,
      senderKey: 'rvc.playback',
      ts: new Date().toISOString(),
      text: `[RVC] ${text}`,
      origin: 'internal',
      tags: ['snapshot'],
    }, { trigger }).catch((err: unknown) => {
      this.log?.warn('RVC 播放状态事件没有送出', { err: err instanceof Error ? err.message : String(err) });
    });
  }

  /** 记下开始播放；返回代次，结束回调据此决定是否还改状态。 */
  private beginPlayback(title: string, kind: LibraryKind, notify: boolean): number {
    const id = ++this.playbackId;
    this.playback = { id, title, kind, durationSec: 0, startedAt: Date.now() };
    if (notify) {
      const label = kind === 'clean' ? 'clean vocal' : 'cover';
      this.pushPlayback(`Started playing "${title}" (${label}).`, 'debounce');
    }
    return id;
  }

  private updatePlaybackDuration(id: number, durationSec: number): void {
    if (this.playback?.id === id) this.playback.durationSec = durationSec;
  }

  private finishPlayback(id: number, reason = 'finished'): void {
    const current = this.playback;
    if (!current || current.id !== id) return;
    this.playback = null;
    this.pushPlayback(`Playback ${reason}: "${current.title}".`, 'debounce');
  }

  /** 新点歌 / 显式停止：先清状态再杀进程，旧 onEnded 不会重复上报。 */
  private stopPlayback(notify: boolean): void {
    const current = this.playback;
    this.playback = null;
    this.playbackId += 1;
    this.songPlayer?.stop();
    if (current && notify) this.pushPlayback(`Stopped "${current.title}".`, 'debounce');
  }

  /** 桌宠点歌：库优先；库里没有就按歌名跑一次 B 站一键翻唱（默认类型读配置），完成后直接播放。 */
  private async rvcSing(args: Record<string, unknown>): Promise<ToolOutcome> {
    const song = typeof args.song === 'string' ? args.song.trim() : '';
    // 显式传了 kind 就以调用为准；没传才用配置里的桌宠默认类型。
    const kind: LibraryKind = args.kind === 'cover' ? 'cover' : args.kind === 'clean' ? 'clean' : this.singKind();
    // source=bilibili 表示用户已经否掉了库里的相近版本，明确要去找原版。
    const source = args.source === 'bilibili' ? 'bilibili' : 'library';
    // 用户在候选表里点了具体一条：按 BV 号直接下载，不再重新搜索、不再换一首。
    const bvid = typeof args.bvid === 'string' && isBvid(args.bvid.trim()) ? args.bvid.trim() : '';
    // 模型自己定的曲名（看过候选、或用户明确说了怎么叫）：优先于视频标题的自动清洗。
    // 不传就沿用自动清洗结果，所以这里只在模型主动给名字时生效。
    const wantedTitle = typeof args.title === 'string'
      ? args.title.replace(/\s+/g, ' ').trim().slice(0, 80).trim()
      : '';
    const player = this.songPlayer;
    // 再点歌先停上一首与上一次自动翻唱；旧任务的结果不再抢播放条。
    this.singGeneration += 1;
    const generation = this.singGeneration;
    this.stopPlayback(false);
    if (this.autoSingBusy) await this.interruptAutoSing();
    if (!player) return { text: 'Nothing played: the local player is not ready.', failed: true };

    if (!bvid && source === 'library') {
      const pick = pickSong(this.libraryDir, { song, kind });
      if ('entry' in pick) {
        const full = join(this.libraryDir, pick.entry.file);
        if (!existsSync(full)) {
          return { text: `Found "${pick.entry.title}" in the library, but its file is missing. Save it again from the RVC panel.`, failed: true };
        }
        const id = this.beginPlayback(pick.entry.title, kind, false);
        try {
          const { durationSec } = await player.playFile(full, { onEnded: () => this.finishPlayback(id) });
          this.updatePlaybackDuration(id, durationSec);
          this.log?.info('桌宠点歌', { title: pick.entry.title, kind, file: pick.entry.file, seconds: durationSec });
          const label = kind === 'clean' ? 'clean vocal, no backing track' : 'cover, with backing track';
          return { text: `Playing "${pick.entry.title}" (${label}), ${clock(durationSec)}.` };
        } catch (err) {
          this.finishPlayback(id, 'failed');
          return {
            text: `Found "${pick.entry.title}", but could not play it on this computer: ${err instanceof Error ? err.message : String(err)}.`,
            failed: true,
          };
        }
      }
      // 只是包含关系 / 版本后缀不同：先问清楚，别直接播成另一个版本。
      if ('ambiguous' in pick) return { text: pick.ambiguous.message };
      // 没给歌名就只能说明；给了歌名继续走 B 站兜底。
      if (!song) return { text: pick.issue.message };
    } else if (!bvid && !song) {
      return { text: 'To look for the original on Bilibili, pass the song name in "song".' };
    }
    if (this.job?.phase === 'working') {
      return { text: 'The RVC panel is busy with another conversion. Wait for it to finish, or stop it, then ask again.' };
    }
    if (!this.biliReady()) {
      return { text: `I cannot make "${song}" automatically: the vocal-separation model is not installed. Ask the person to open the RVC panel and click "install" on the Service page.`, failed: true };
    }
    const query = song.replace(/[《》「」『』]/g, '').trim() || bvid;
    let decision: BiliPick;
    if (bvid) {
      decision = {
        confident: true,
        reason: 'ok',
        candidates: [{ bvid, title: song || bvid, author: '', durationSec: 0, play: 0 }],
      };
    } else {
      let hits: SearchHit[];
      try {
        hits = await this.bili.search(query, 20);
      } catch (err) {
        return { text: `Bilibili search for "${query}" failed: ${err instanceof Error ? err.message : String(err)}. Try again later.`, failed: true };
      }
      if (generation !== this.singGeneration) return { text: 'Cancelled: another song was requested.' };
      decision = pickCandidates(hits, query, 6);
    }
    if (!decision.candidates.length) {
      return { text: `Bilibili returned no results for "${query}". Try another song name later.` };
    }
    if (!decision.confident) {
      return {
        text: `I could not pick a reliable Bilibili version for "${query}" (${decision.reason}). Ask the person which one to use; list them, then call rvc_sing again with bvid set to the chosen BV id:\n${candidateLines(decision.candidates)}`,
      };
    }
    // 生成链路需要引擎：停着就先拉起并等就绪，最多 90 秒；拉不起来把原因直接回给模型。
    const ready = await this.ensureReadyForTool();
    if (!ready.ok) {
      return { text: `I could not start the RVC engine, so I cannot make "${query}" right now: ${ready.reason}.`, failed: true };
    }
    // 先把音频下下来：下载失败要当场回原因，别让用户等几分钟后才发现没下成。
    const download = await this.downloadBiliCandidates(decision.candidates, query);
    if (!download.source) {
      return {
        text: `The Bilibili audio download for "${query}" failed: ${download.failures.slice(-1)[0] ?? 'no usable candidate'}. Try again later.`,
        failed: true,
      };
    }
    if (generation !== this.singGeneration) {
      rmSync(download.source, { force: true });
      return { text: 'Cancelled: another song was requested.' };
    }
    const displayTitle = wantedTitle || download.title || query;
    this.startAutoSing(generation, displayTitle, kind, download.source, player);
    const spoken = displayTitle;
    return {
      text: `I haven't sung "${spoken}" before. I'm going to sing it now; it usually takes 2-5 minutes, and it will play on its own when it is ready. Say another song to cancel.`,
    };
  }

  /** 桌宠自己找歌：关键词匹配库里的标题，不要求用户先报完整歌名。 */
  private findLibrarySongs(args: Record<string, unknown>): ToolOutcome {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const kind = args.kind === 'cover' ? 'cover' : args.kind === 'clean' ? 'clean' : undefined;
    const rawLimit = typeof args.limit === 'number' ? args.limit : 20;
    const limit = Math.min(50, Math.max(1, Math.round(rawLimit)));
    let result: ReturnType<typeof findSongs>;
    try {
      result = findSongs(this.libraryDir, query, kind, limit);
    } catch (err) {
      return { text: `Could not read the cover library: ${err instanceof Error ? err.message : String(err)}.`, failed: true };
    }
    if (!result.matches.length) {
      return {
        text: query
          ? `No saved song matches "${query}". ${result.total ? `${result.total} songs are saved; ask the person for a title, or call rvc_find with an empty query to list them.` : 'The cover library is empty.'}`
          : 'The cover library is empty.',
      };
    }
    const lines = result.matches.map((entry, at) => {
      const label = entry.kind === 'clean' ? 'clean vocal' : 'cover';
      return `${at + 1}. "${entry.title}" — ${label}, ${clock(entry.durationSec)}`;
    });
    const heading = query
      ? `Songs matching "${query}" (${result.total}):`
      : `Saved songs (${result.total}):`;
    return {
      text: `${heading}\n${lines.join('\n')}\nUse rvc_sing with an exact title from this list to play one; ask the person if several could fit.`,
    };
  }

  /** 当前播放 / 准备状态；模型不用靠猜。 */
  private playbackState(): ToolOutcome {
    const engine = this.engine?.state();
    const engineText = engine?.phase === 'ready'
      ? 'ready'
      : engine?.phase === 'starting'
        ? 'starting'
        : engine?.phase === 'error'
          ? `error: ${engine.detail || this.launchDetail || 'unknown'}`
          : 'stopped';
    const suffix = ` Engine: ${engineText}. Volume: ${this.volume}%.`;
    const current = this.playback;
    if (current) {
      const elapsed = Math.max(0, Math.floor((Date.now() - current.startedAt) / 1000));
      const label = current.kind === 'clean' ? 'clean vocal' : 'cover';
      const total = current.durationSec > 0 ? ` of ${clock(current.durationSec)}` : '';
      return {
        text: `Playing "${current.title}" (${label}), ${clock(elapsed)}${total} elapsed. Call rvc_stop to stop it.${suffix}`,
      };
    }
    if (this.autoSingBusy) {
      return { text: `Preparing "${this.autoSingQuery || 'a song'}" in the background; nothing is playing yet.${suffix}` };
    }
    return { text: `Nothing is playing right now.${suffix}` };
  }

  /** 桌宠点名的「启动 RVC」：清掉手动停止的印记，拉起引擎并等到就绪。 */
  private async startEngineForTool(): Promise<ToolOutcome> {
    if (this.stopped) return { text: 'RVC is not mounted right now.', failed: true };
    if (this.engine?.ready()) return { text: `RVC is already running. Volume is ${this.volume}%.` };
    this.engineHeld = false;
    this.idleStopped = false;
    this.launchDetail = '';
    if (!this.engine) this.setup();
    const ready = await this.ensureReadyForTool(90_000);
    if (ready.ok) return { text: `RVC is ready. Volume is ${this.volume}%.` };
    return {
      text: `RVC did not start: ${ready.reason}. Ask the person to check the Service page in the RVC panel.`,
      failed: true,
    };
  }

  /** 桌宠调音量：level 绝对值优先，其次 delta 相对当前值；都不传就报当前音量。 */
  private setVolumeTool(args: Record<string, unknown>): ToolOutcome {
    const level = typeof args.level === 'number' ? args.level : Number.NaN;
    const delta = typeof args.delta === 'number' ? args.delta : Number.NaN;
    if (!Number.isFinite(level) && !Number.isFinite(delta)) {
      return { text: `Volume is ${this.volume}%.` };
    }
    const next = this.applyVolume(Number.isFinite(level) ? level : this.volume + delta);
    return { text: `Volume set to ${next}%.` };
  }

  /** 面板/桌宠共用：写回配置的活引用，并让正在播的歌立即换音量。 */
  private applyVolume(value: number): number {
    const next = clampVolume(value);
    this.volume = next;
    this.opts.cfg.volume = next;
    this.songPlayer?.setVolume(next);
    return next;
  }

  /** 停止当前播放，并取消还在后台准备的翻唱。 */
  private async stopSinging(): Promise<ToolOutcome> {
    const wasPlaying = this.playback?.title ?? '';
    const wasPreparing = this.autoSingBusy;
    this.singGeneration += 1;
    this.autoSingBusy = false;
    this.autoSingQuery = '';
    this.stopPlayback(true);
    if (wasPreparing) await this.interruptAutoSing();
    if (wasPlaying) return { text: `Stopped "${wasPlaying}".` };
    if (wasPreparing) return { text: 'Cancelled the cover that was being prepared.' };
    return { text: 'Nothing was playing.' };
  }

  /** 再次点歌时打断上一次自动翻唱：停掉 worker，别让新歌排在几分钟的推理后面。 */
  private async interruptAutoSing(): Promise<void> {
    this.autoSingBusy = false;
    const engine = this.engine;
    if (!engine) return;
    try { await engine.stop(); } catch { /* 已经停了 */ }
    if (this.stopped || this.engineHeld) return;
    // 下一条请求需要能自动拉起引擎；这里主动重启，避免第一次等待更久。
    this.idleStopped = false;
    this.bootEngine(false);
  }

  /** 后台跑一次自动翻唱：下载候选 → 现有翻唱链路 → 入库 → 播放。失败只记说明，不抛给模型。 */
  private startAutoSing(
    generation: number,
    title: string,
    kind: LibraryKind,
    source: string,
    player: SongPlayer,
  ): void {
    this.autoSingBusy = true;
    this.autoSingQuery = title;
    const bgm = kind === 'cover';
    const task = (async () => {
      try {
        const result = await this.coverFromPanel([`${safeSongName(title)}.m4a`, '', {
          path: source,
          voice: '',
          pitch: 0,
          indexRate: 0.3,
          protect: 0.33,
          vocalGain: 0,
          format: 'wav',
          chunk: true,
          keepSource: this.keepSourceByDefault(),
          withBgm: bgm,
          // 配置里关掉「默认入库」时仍照常播放，只是不写翻唱库。
          toLibrary: this.saveToLibraryByDefault(),
          title,
        }]) as { library?: { file: string; title: string }; libraryError?: string; savedPath?: string };
        if (generation !== this.singGeneration) return;
        const target = result.library?.file ? join(this.libraryDir, result.library.file) : result.savedPath;
        if (!target) {
          this.log?.warn('桌宠点歌：生成完成但没有可播放文件', {
            title, err: result.libraryError || 'no saved output',
          });
          return;
        }
        const playTitle = result.library?.title ?? title;
        const id = this.beginPlayback(playTitle, kind, true);
        try {
          const { durationSec } = await player.playFile(target, { onEnded: () => this.finishPlayback(id) });
          this.updatePlaybackDuration(id, durationSec);
          this.log?.info('桌宠点歌：自动翻唱后播放', {
            title: playTitle, seconds: durationSec, savedToLibrary: !!result.library,
          });
        } catch (err) {
          this.finishPlayback(id, 'failed to start');
          this.log?.warn('桌宠点歌：自动翻唱后播放失败', { err: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        rmSync(source, { force: true });
      }
    })();
    void task.catch((err: unknown) => {
      if (generation === this.singGeneration) {
        this.log?.warn('桌宠点歌：自动翻唱失败', { title, err: err instanceof Error ? err.message : String(err) });
      }
    }).finally(() => {
      if (generation !== this.singGeneration) return;
      this.autoSingBusy = false;
      this.autoSingQuery = '';
    });
  }

  private deleteSession(id: string): Record<string, unknown> {
    if (this.job?.phase === 'working') throw new RvcError('param', '有任务在跑，等它结束再删会话');
    if (!removeSession(this.opts.dataDir, id)) throw new RvcError('param', `找不到会话：${id || '(空)'}`);
    if (this.activeSession === id) this.activeSession = null;
    this.log?.info('删除 RVC 翻唱会话', { id });
    return this.refineState();
  }

  private cleanupSessions(): Record<string, unknown> {
    if (this.job?.phase === 'working') throw new RvcError('param', '有任务在跑，等它结束再清理');
    const result = this.gcSessions();
    return { ...this.refineState(), cleaned: result.removed.length, freed: result.freed };
  }

  /**
   * 面板「另存」：把成品（混音或母带）或原声读成 base64 交给浏览器保存
   * （原生保存框或下载），不经过 PowerShell。`args[2]` 是成品序号，省略则取最近一条。
   */
  private sessionFile(args: unknown[]): Record<string, unknown> {
    const id = typeof args[0] === 'string' ? args[0] : '';
    const requested = args[1] === 'source' ? 'source' : args[1] === 'master' ? 'master' : 'output';
    const index = Number(args[2]);
    const dir = sessionDir(this.opts.dataDir, id);
    const session = dir ? readSession(this.opts.dataDir, id) : null;
    if (!dir || !session) throw new RvcError('param', `找不到会话：${id || '(空)'}`);
    let rel: string | undefined;
    if (requested === 'source') {
      rel = session.source.file;
    } else {
      const list = requested === 'master' ? session.masters ?? [] : session.outputs;
      const item = Number.isInteger(index) ? list[index] : list[list.length - 1];
      rel = item?.path;
    }
    if (!rel) {
      throw new RvcError('param', requested === 'source'
        ? '这个会话没有原声副本'
        : requested === 'master' ? '这个会话还没有母带' : '这个会话还没有成品');
    }
    const source = join(dir, rel);
    if (!existsSync(source)) throw new RvcError('param', `文件不在了：${rel}`);
    const ext = extname(rel).toLowerCase() || '.wav';
    const bytes = readFileSync(source);
    return {
      name: `cover-${id}${ext}`,
      ext,
      bytes: bytes.length,
      mime: AUDIO_MIME[ext] ?? 'application/octet-stream',
      base64: bytes.toString('base64'),
    };
  }

  /** 双阈值清理：只动 `sessions/`，正在用的会话永远跳过。 */
  private gcSessions(): { removed: string[]; freed: number } {
    const result = gcSessions(this.opts.dataDir, {
      days: Math.max(0, Math.floor(Number(this.opts.cfg.sessionDays) || 0)),
      maxGb: Math.max(0, Number(this.opts.cfg.sessionMaxGb) || 0),
      keep: this.activeSession ? [this.activeSession] : [],
    });
    if (result.removed.length) this.log?.info('清理 RVC 翻唱会话', result);
    return result;
  }

  /** 面板发起的变声/翻唱：后台跑，面板立刻返回，用户可以切到别的页；结果用 `takeResult` 取。 */
  private job: { kind: 'convert' | 'cover' | 'remix' | 'range' | 'master'; at: number; phase: 'working' | 'done' | 'error'; detail: string; error?: string; ms?: number } | null = null;
  private jobResult: { mime: string; base64: string; savedPath: string | null; ms: number } | null = null;

  private async invoke(panel: string, method: string, args: unknown[] = []): Promise<unknown> {
    if (method === 'state' || method === 'install' || method === 'cancel' || method === 'restart' || method === 'start' || method === 'stop' || method === 'takeResult' || method === 'setVolume') {
      if (method === 'install') this.startSetup();
      else if (method === 'cancel') { this.runtime?.cancel(); this.installer?.cancel(); this.venv?.cancel(); }
      else if (method === 'restart') void this.restartEngine();
      else if (method === 'start') this.startEngine();
      else if (method === 'stop') await this.stopEngine();
      else if (method === 'setVolume') this.applyVolume(Number(args[0]));
      else if (method === 'takeResult') {
        const result = this.jobResult;
        this.jobResult = null;
        return result ?? { error: '没有可取的结果' };
      }
      return this.status();
    }
    if (method === 'convert' || method === 'cover' || method === 'remix' || method === 'master') {
      this.beginJob(method, args);
      return this.status();
    }
    if (method === 'coverRerun') {
      this.beginJob('cover', args, 'coverRerun');
      return this.status();
    }
    if (method === 'biliCover') {
      this.beginJob('cover', args, 'biliCover');
      return this.status();
    }
    if (method === 'biliSearch') return this.biliSearch(args);
    if (method === 'rangeConvert') {
      this.beginJob('range', args);
      return this.status();
    }
    if (method === 'segmentRedo' || method === 'segmentRevert') {
      this.beginJob('range', args, method);
      return this.status();
    }
    if (method === 'segmentMute' || method === 'segmentCut' || method === 'segmentMerge') {
      return this.segmentEdit(method, args);
    }
    if (method === 'refineState') return this.refineState(String(args[0] ?? ''), args[1] === 'list');
    if (method === 'refinePeaks') return this.peaksFromPanel(String(args[0] ?? ''));
    if (method === 'exportF0') return this.f0FromPanel(String(args[0] ?? ''));
    if (method === 'refinePitch') return this.pitchFromPanel(String(args[0] ?? ''));
    if (method === 'refineAudio') return this.audioFromPanel(args);
    if (method === 'refinePreview') {
      const raw = (args[1] && typeof args[1] === 'object' ? args[1] : {}) as Record<string, unknown>;
      return this.previewSession(String(args[0] ?? ''), raw);
    }
    if (method === 'sessionDelete') return this.deleteSession(String(args[0] ?? ''));
    if (method === 'sessionFiles') return this.sessionFiles(String(args[0] ?? ''));
    if (method === 'sessionFile') return this.sessionFile(args);
    if (method === 'librarySave') return this.librarySave(args);
    if (method === 'libraryState') return this.libraryState();
    if (method === 'libraryOpen') return this.libraryOpen();
    if (method === 'downloadSeparator') return this.downloadSeparator();
    if (method === 'cancelSeparator') return this.cancelSeparator();
    if (method === 'removeSeparator') return this.removeSeparator();
    if (method === 'libraryFile') return this.libraryFile(String(args[0] ?? ''));
    if (method === 'libraryDelete') return this.libraryDelete(String(args[0] ?? ''));
    if (method === 'cleanupSessions') return this.cleanupSessions();
    if (method === 'storage') return { items: this.storage() };
    if (method === 'uninstall') return this.uninstall(String(args[0] ?? ''));
    if (method === 'voices') return { voices: listVoices(this.voicesDir) };
    if (method === 'import') {
      const fileName = typeof args[0] === 'string' ? args[0] : '';
      const base64 = typeof args[1] === 'string' ? args[1] : '';
      if (!fileName || !base64) return { error: '需要文件名与 base64 内容' };
      try {
        const done = importVoiceFile(this.voicesDir, fileName, Buffer.from(base64, 'base64'));
        this.log?.info('导入 RVC 音色', done);
        return { ...done, voices: listVoices(this.voicesDir) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
    if (method === 'addVoice') return this.addVoice(args);
    if (method === 'deleteVoice') return this.removeVoice(args);
    if (method === 'uploadVoiceChunk') return this.uploadVoiceChunk(args);
    if (method === 'finishVoice') return this.finishVoice(args);
    if (method === 'cancelVoiceUpload') return this.cancelVoiceUpload(args);
    return { error: `unknown method: ${panel}.${method}` };
  }

  /** 大文件分块上传的临时路径；放在 voices 目录里，装完后可同盘 rename。 */
  private uploadPath(id: string, kind: 'pth' | 'index'): string {
    const safe = /^[a-z0-9-]{8,64}$/i.test(id) ? id : '';
    if (!safe) throw new RvcError('param', '上传编号不合法');
    return join(this.voicesDir, `.upload-${safe}-${kind}`);
  }

  /** 音色文件分块上传：每块 base64，index=0 时覆盖旧临时文件，之后追加。 */
  private uploadVoiceChunk(args: unknown[]): Record<string, unknown> {
    const id = String(args[0] ?? '');
    const kind = args[1];
    const index = Number(args[2]);
    const total = Number(args[3]);
    const b64 = typeof args[4] === 'string' ? args[4] : '';
    if (kind !== 'pth' && kind !== 'index') return { error: '文件类型不合法' };
    if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || total > 4096 || index < 0 || index >= total) {
      return { error: '分块参数不合法' };
    }
    if (!b64) return { error: '分块内容为空' };
    try {
      const path = this.uploadPath(id, kind);
      if (index > 0 && !existsSync(path)) return { error: '分块顺序断了，请重新选择文件' };
      const buf = Buffer.from(b64, 'base64');
      if (buf.length > 8 * 1024 * 1024) return { error: '单个分块太大' };
      mkdirSync(this.voicesDir, { recursive: true });
      if (index === 0) writeFileSync(path, buf);
      else appendFileSync(path, buf);
      return { received: index + 1, total };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 分块传完后安装音色；校验头与大小后改名为 `<name>.pth` / `<name>.index`。 */
  private finishVoice(args: unknown[]): Record<string, unknown> {
    const name = typeof args[0] === 'string' ? args[0].trim() : '';
    const pthId = String(args[1] ?? '');
    const idxId = args[2] ? String(args[2]) : '';
    if (!name) return { error: '请填写音色名称' };
    let pthPath = '';
    let idxPath: string | null = null;
    try {
      pthPath = this.uploadPath(pthId, 'pth');
      idxPath = idxId ? this.uploadPath(idxId, 'index') : null;
      if (!existsSync(pthPath)) return { error: '没有收到 .pth 文件，请重新选择文件' };
      if (idxPath && !existsSync(idxPath)) return { error: '没有收到 .index 文件，请重新选择文件' };
      const base = voiceBaseName(name);
      if (listVoices(this.voicesDir).some((voice) => voice.name.toLowerCase() === base.toLowerCase())) {
        return { error: `音色 ${base} 已存在；先删除再导入` };
      }
      const done = installVoiceFiles(this.voicesDir, base, pthPath, idxPath);
      this.opts.cfg.voice = done.name;
      this.log?.info('添加 RVC 音色', { name: done.name, bytes: done.bytes, index: done.index });
      return { ...done, voices: listVoices(this.voicesDir) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (pthPath) rmSync(pthPath, { force: true });
      if (idxPath) rmSync(idxPath, { force: true });
    }
  }

  /** 取消分块上传：删掉两个临时文件。 */
  private cancelVoiceUpload(args: unknown[]): Record<string, unknown> {
    const id = String(args[0] ?? '');
    try {
      for (const kind of ['pth', 'index'] as const) rmSync(this.uploadPath(id, kind), { force: true });
      return { ok: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 添加音色：`.pth` 必填、`.index` 可选；按音色名统一命名，保证两者同名配对。 */
  private addVoice(args: unknown[]): Record<string, unknown> {
    const name = typeof args[0] === 'string' ? args[0].trim() : '';
    const pthB64 = typeof args[2] === 'string' ? args[2] : '';
    const idxB64 = typeof args[4] === 'string' ? args[4] : '';
    if (!name) return { error: '请填写音色名称' };
    if (!pthB64) return { error: '请选择 .pth 模型文件' };
    try {
      const base = voiceBaseName(name);
      if (listVoices(this.voicesDir).some((voice) => voice.name.toLowerCase() === base.toLowerCase())) {
        return { error: `音色 ${base} 已存在；先删除再导入` };
      }
      const done = importVoicePair(
        this.voicesDir,
        base,
        Buffer.from(pthB64, 'base64'),
        idxB64 ? Buffer.from(idxB64, 'base64') : null,
      );
      // 与 GPT-SoVITS 的「添加音色」一致：新音色直接设为当前默认。
      this.opts.cfg.voice = done.name;
      this.log?.info('添加 RVC 音色', { name: done.name, bytes: done.bytes, index: done.index });
      return { ...done, voices: listVoices(this.voicesDir) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 删除音色：`.pth` 与同名 `.index` 一起删；删的是当前默认音色时回退到目录里第一个。 */
  private removeVoice(args: unknown[]): Record<string, unknown> {
    const name = typeof args[0] === 'string' ? args[0] : '';
    try {
      const done = removeVoiceFile(this.voicesDir, name);
      if (this.opts.cfg.voice.trim() === done.name) this.opts.cfg.voice = '';
      this.log?.info('删除 RVC 音色', done);
      return { ...done, voices: listVoices(this.voicesDir) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 占用统计：只报 id 与字节数，名字由面板翻。`shared` 的项不归 RVC 管，不能在这里删。 */
  private storage(): Array<{ id: string; bytes: number; shared: boolean }> {
    return [
      { id: 'runtime', bytes: this.runtimeDir ? dirBytes(this.runtimeDir) : 0, shared: true },
      { id: 'venv', bytes: dirBytes(dirname(dirname(this.pythonPath))), shared: false },
      { id: 'assets', bytes: dirBytes(this.assetsDir), shared: false },
      { id: 'voices', bytes: dirBytes(this.voicesDir), shared: false },
      { id: 'uvr5', bytes: dirBytes(this.uvrDir), shared: false },
      { id: 'sessions', bytes: dirBytes(sessionsRoot(this.opts.dataDir)), shared: false },
    ];
  }

  /** 面板「卸载」：停引擎后删掉 RVC 自己的文件；共享运行时属于 gpt-sovits，不在这里动。 */
  private async uninstall(id: string): Promise<Record<string, unknown>> {
    if (this.job?.phase === 'working') throw new RvcError('param', '有任务在跑，等它结束再卸载');
    if (id === 'runtime') throw new RvcError('param', '共享运行时由 gpt-sovits / 唱歌插件共用，不能在 RVC 里卸载');
    const targets: Record<string, string> = {
      venv: dirname(dirname(this.pythonPath)),
      assets: this.assetsDir,
      voices: this.voicesDir,
      uvr5: this.uvrDir,
      sessions: sessionsRoot(this.opts.dataDir),
    };
    const target = targets[id];
    if (!target) throw new RvcError('param', `未知的模型：${id}`);
    await this.engine?.stop();
    rmSync(target, { recursive: true, force: true });
    if (id === 'venv') this.venv?.reset();
    if (id === 'sessions') this.activeSession = null;
    this.launchDetail = '已卸载，点「一键安装」可重新装回';
    this.log?.info('卸载 RVC 数据', { id, path: target });
    return { ...this.status(), storage: this.storage() };
  }

  /** 把变声/翻唱/选段重跑/段落重做放到后台跑：面板拿到的是即时状态，不用在页面上等。 */
  private beginJob(
    kind: 'convert' | 'cover' | 'remix' | 'range' | 'master',
    args: unknown[],
    action: 'convert' | 'cover' | 'coverRerun' | 'biliCover' | 'remix' | 'range' | 'master' | 'segmentRedo' | 'segmentRevert' = kind,
  ): void {
    if (this.job?.phase === 'working') throw new RvcError('param', '已有任务在跑，等它结束再试');
    if (this.autoSingBusy) throw new RvcError('param', '正在按歌名自动生成翻唱，等它结束或再点一首取消后再试');
    const at = Date.now();
    const detail = action === 'cover' ? '分离人声'
      : action === 'coverRerun' ? '重跑变声并混音'
        : action === 'biliCover' ? '下载并生成翻唱'
      : action === 'range' ? '重跑选段'
        : action === 'segmentRedo' ? '重做段落'
          : action === 'segmentRevert' ? '还原段落'
            : action === 'remix' ? '重新混音'
              : action === 'master' ? '母带处理' : '变声';
    this.job = { kind, at, phase: 'working', detail };
    this.jobResult = null;
    const task = action === 'cover'
      ? this.coverFromPanel(args)
      : action === 'biliCover'
        ? this.biliCoverFromPanel(args)
        : action === 'coverRerun'
        ? this.rerunFromPanel(args)
        : action === 'range'
        ? this.rangeFromPanel(args)
        : action === 'segmentRedo'
          ? this.segmentFromPanel(args, 'redo')
          : action === 'segmentRevert'
            ? this.segmentFromPanel(args, 'revert')
            : action === 'remix'
              ? this.remixFromPanel(args)
              : action === 'master'
                ? this.masterFromPanel(args)
                : this.convertFromPanel(args);
    task.then((res) => {
      const bin = (res as { $binary?: { mime: string; base64: string } }).$binary;
      const last = kind === 'cover' ? this.lastCover
        : kind === 'range' ? this.lastRange
          : kind === 'remix' ? this.lastMix
            : kind === 'master' ? this.lastMaster
              : this.lastConvert;
      if (bin) {
        this.jobResult = { mime: bin.mime, base64: bin.base64, savedPath: last?.savedPath ?? null, ms: last?.ms ?? 0 };
        this.job = { kind, at, phase: 'done', detail: '完成', ms: last?.ms ?? 0 };
      } else {
        this.job = { kind, at, phase: 'error', detail: '失败', error: '没有拿到音频' };
      }
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (isMemoryError(message)) {
        // 提交内存被 worker 自己越吃越多时，30 MB 的分配也会失败。把 worker 停掉把内存还给系统，
        // 下一次请求会自动拉起新进程；不设 engineHeld，用户不需要再手动点「启动引擎」。
        void this.engine?.stop().catch(() => undefined);
        this.job = {
          kind, at, phase: 'error', detail: '失败',
          error: `${message}\n\n内存不足：已停止 RVC 引擎释放内存。关掉占内存的程序后再点一次，引擎会自动重新启动。`,
        };
        return;
      }
      this.job = { kind, at, phase: 'error', detail: '失败', error: message };
    }).finally(() => {
      // 任务结束后再排期：`armIdle()` 在 job 还是 working 时会直接返回。
      this.armIdle();
    });
  }

  /** 配置里的桌宠默认类型；老配置没有这个字段时按清唱。 */
  private singKind(): LibraryKind {
    return this.opts.cfg.singKind === 'cover' ? 'cover' : 'clean';
  }

  /** 配置里的面板默认类型；老配置没有这个字段时按翻唱。 */
  private panelKind(): LibraryKind {
    return this.opts.cfg.panelKind === 'clean' ? 'clean' : 'cover';
  }

  /** 翻唱完成后默认是否入库；老配置没有这个字段时保持旧行为（入库）。 */
  private saveToLibraryByDefault(): boolean {
    return this.opts.cfg.saveToLibrary !== false;
  }

  /** 默认是否保留原声副本；老配置没有这个字段时保持旧行为（保留）。 */
  private keepSourceByDefault(): boolean {
    return this.opts.cfg.keepSource !== false;
  }

  /** 面板与状态行看到的一切。 */
  private status(): Record<string, unknown> {
    const st: EngineState | null = this.engine ? this.engine.state() : null;
    const voices = listVoices(this.voicesDir);
    return {
      phase: st?.phase ?? 'stopped',
      ready: this.health().ready,
      tier: this.opts.cfg.tier,
      runtimeTier: this.runtimeTier,
      runtime: this.runtime?.status() ?? null,
      runtimeTiers: installedTiers(this.runtimesRoot),
      device: st?.device ?? null,
      model: st?.model ?? null,
      startMs: st?.startMs ?? null,
      queue: this.engine?.queue() ?? 0,
      port: this.server?.port ?? (this.opts.cfg.httpApi ? this.opts.cfg.httpPort : null),
      detail: st?.detail ?? this.launchDetail,
      tail: this.engine?.output() ?? [],
      codeDir: this.codeDir,
      assetsDir: this.assetsDir,
      voicesDir: this.voicesDir,
      uvrDir: this.uvrDir,
      pythonPath: this.pythonPath,
      runtimeDir: this.runtimeDir,
      uvr5: hasUvr5(this.uvrDir),
      uvr: this.installer?.uvr.status() ?? { phase: 'absent', done: 0, total: 0, detail: 'World 未启动' },
      melband: this.melbandJob?.status() ?? { phase: 'absent', done: 0, total: 0, detail: 'World 未启动' },
      highSeparator: this.opts.cfg.highSeparator === true,
      venv: this.venv?.state() ?? { phase: 'absent', detail: 'World 未启动' },
      install: this.installer?.state() ?? { phase: 'absent', done: 0, total: 0, detail: 'World 未启动' },
      voiceCount: voices.length,
      defaultVoice: this.defaultVoice(voices),
      volume: this.volume,
      defaults: {
        singKind: this.singKind(),
        panelKind: this.panelKind(),
        saveToLibrary: this.saveToLibraryByDefault(),
        keepSource: this.keepSourceByDefault(),
      },
      lastConvert: this.lastConvert,
      lastCover: this.lastCover,
      lastMix: this.lastMix,
      lastRange: this.lastRange,
      lastMaster: this.lastMaster,
      job: this.job,
      resultReady: this.jobResult !== null,
    };
  }

  /** 默认音色：配置里写的，没写就是目录里第一个。 */
  private defaultVoice(voices: ReturnType<typeof listVoices>): string {
    return this.opts.cfg.voice.trim() || voices[0]?.name || '';
  }

  /** 面板点「一键安装」：先停引擎，再（缺的话）下共享运行时、建派生 venv、补依赖、下权重，装完自动重拉引擎。 */
  private startSetup(): void {
    const installer = this.installer;
    const venv = this.venv;
    if (!installer || !venv) return;
    if (venv.state().phase === 'working' || installer.state().phase === 'working') return;
    void (async () => {
      // worker 在跑时会占住 venv 里的 .pyd/.dll，pip 覆盖不了这些文件；先停掉再装。
      await this.engine?.stop();
      if (this.stopped) return;
      // 没用自备运行时、部署里也没有 gpt-sovits 运行时：自己下一份（CPU 档约 1 GB / 显卡档约 4 GB），
      // 布局和 gpt-sovits 装的一模一样，三个插件共用同一份，谁先装都一样。
      const runtime = this.runtime;
      if (runtime && !runtime.ready() && !this.opts.cfg.runtimeDir.trim()) {
        const ok = await runtime.ensure();
        if (this.stopped) return;
        if (!ok) {
          this.log?.warn('共享运行时没装成，先不建派生 venv', { detail: runtime.status().detail });
          return;
        }
        this.setup();
      }
      await this.venv?.ensure();
      if (this.stopped) return;
      if (this.venv?.state().phase !== 'ready') {
        this.log?.warn('RVC 依赖没装好，先不下载权重', { detail: this.venv?.state().detail });
        return;
      }
      await installer.install();
      if (this.stopped) return;
      const state = installer.state();
      this.log?.info('RVC 资产安装结束', { phase: state.phase, detail: state.detail });
      if (state.phase === 'ready' && !this.engine?.ready()) this.bootEngine();
    })();
  }

  private async restartEngine(): Promise<void> {
    // 「重启」是明确的启动意图：手动停过的印记在这里清掉。
    this.engineHeld = false;
    this.idleStopped = false;
    this.cancelIdle();
    await this.engine?.stop();
    if (this.stopped) return;
    // 可能改过推理档/运行时：按当前配置重建 venv 与引擎（venv 的 base 变了会自动重建）。
    this.setup();
    const venv = this.venv;
    if (!venv) return;
    await venv.check();
    if (this.stopped) return;
    if (venv.state().phase === 'ready') {
      this.bootEngine(false);
      return;
    }
    // 切了推理档或依赖没装：重建派生 venv，装完再拉起引擎，面板能看到「安装中」。
    void venv.ensure().then(() => {
      if (!this.stopped && venv.state().phase === 'ready') this.bootEngine(false);
    });
  }

  /** 面板「启动引擎」：清掉手动停止的印记，按当前配置重拉。 */
  private startEngine(): void {
    this.engineHeld = false;
    this.idleStopped = false;
    this.launchDetail = '';
    if (!this.engine) this.setup();
    this.bootEngine(false);
  }

  /** 面板「停止引擎」：立刻释放显存/内存；之后装依赖、切档都不会再把引擎拉起来，直到用户再点启动。 */
  private async stopEngine(): Promise<void> {
    this.engineHeld = true;
    this.idleStopped = false;
    this.cancelIdle();
    this.launchDetail = '';
    await this.engine?.stop();
  }

  /** 面板上传一条音频：走和 HTTP 接口同一套校验与本机文件转换，回二进制。 */
  private async convertFromPanel(args: unknown[]): Promise<unknown> {
    const fileName = typeof args[0] === 'string' ? args[0] : '';
    const base64 = typeof args[1] === 'string' ? args[1] : '';
    const raw = (args[2] && typeof args[2] === 'object' ? args[2] : {}) as Record<string, unknown>;
    const engine = this.engine;
    if (!engine) throw new RvcError('unavailable', 'RVC 引擎未启动');
    if (!base64) throw new RvcError('param', '缺少音频内容');
    const fields: Record<string, string> = { save: '1' };
    for (const key of ['voice', 'pitch', 'indexRate', 'protect', 'format', 'separator', 'chunk']) {
      const value = raw[key];
      if (value !== undefined && value !== null && value !== '') fields[key] = String(value);
    }
    // 先按接口同一套规则校验参数，再问引擎：填错了立刻能看到原因。
    let job: ConvertJob;
    try {
      job = readConvertJob({ fields, file: { filename: fileName || 'input.wav', data: Buffer.from(base64, 'base64') } }, { uvr5: hasUvr5(this.uvrDir) });
    } catch (err) {
      throw new RvcError('param', err instanceof Error ? err.message : String(err));
    }
    if (!engine.ready()) {
      await this.ensureReady();
      if (!engine.ready()) throw new RvcError('unavailable', engine.state().detail ?? 'RVC 引擎未就绪');
    }
    const out = await this.convert(job);
    return { $binary: { mime: job.format === 'mp3' ? 'audio/mpeg' : 'audio/wav', base64: out.audio.toString('base64') } };
  }
}

/** B 站音频上限：一首歌通常 3–8 MB，200 MB 足够挡住异常大的视频。 */
const MAX_BILI_BYTES = 200 * 1024 * 1024;

/** 给模型看候选：标题 / UP 主 / 时长，够它转述让用户选。 */
function candidateLines(candidates: SearchHit[]): string {
  if (!candidates.length) return '(no candidates)';
  return candidates.slice(0, 6).map((hit, at) =>
    `${at + 1}. ${hit.title} — ${hit.author || 'unknown'} · ${clock(hit.durationSec)} · ${hit.bvid}`).join('\n');
}

/** 面板回传的候选：只收合法 BV 号，其余忽略。 */
function parseBiliCandidates(raw: unknown): SearchHit[] {
  if (!Array.isArray(raw)) return [];
  const out: SearchHit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const bvid = typeof row.bvid === 'string' ? row.bvid.trim() : '';
    if (!isBvid(bvid)) continue;
    out.push({
      bvid,
      title: typeof row.title === 'string' ? row.title : '',
      author: typeof row.author === 'string' ? row.author : '',
      durationSec: Number(row.durationSec) || 0,
      play: Number(row.play) || 0,
      ...(typeof row.score === 'number' ? { score: row.score } : {}),
    });
  }
  return out;
}

/** `20261027-193000`。 */
function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 面板传进来的数字：非有限值回落到默认值，再夹到区间内。 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const silentLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, emit: () => {},
  child: () => silentLogger,
};
