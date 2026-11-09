/**
 * RVC 变声 World：`kind = world`，只做「音频进、音频出」。
 *
 * 挂载时拉起两样东西：
 * 1. 常驻 Python worker（`src/python/worker.py`，见 engine.ts）——载入模型并预热，之后热态 0.3 秒；
 * 2. 本机 HTTP 接口（server.ts，默认 127.0.0.1:9881）——给其他插件与面板用。
 *
 * 本 World 不注册工具、不发事件：文字由 gpt-sovits 管，QQ 消息由 QQ 插件管。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Language } from 'cortico/core/language.ts';
import type { Logger, World, WorldHost, WorldLamp, WorldWebUiDecl } from 'cortico/core/types.ts';
import { configGroups, DEFAULT_PORT, RVC_ID, worldLabel, type RvcConfigSection, type RvcTier } from './config.ts';
import { UVR_MODEL_FILE } from './catalog.ts';
import { RvcEngine, RvcError, type ConvertDone, type EngineState } from './engine.ts';
import { RvcInstaller } from './install.ts';
import { readConvertJob, startConvertServer, type ConvertDeps, type ConvertJob, type ConvertServerHandle } from './server.ts';
import { RvcVenv } from './venv.ts';
import { RuntimeInstall, installedTiers } from './runtime.ts';
import { importVoiceFile, listVoices } from './voices.ts';
import { createSession, defaultSegments, dirBytes, gcSessions, listSessions, readSession, removeSession, sessionDir, sessionsRoot, writeSession, type RefineSession } from './session.ts';
import {
  cutSegment, ensureSegments, mergeSegments, muteSegment, mutedRanges, readPeaks, redoSegment,
  rerunRange, revertSegment, type RangeOptions,
} from './refine.ts';
import { panelText } from './webui/text.ts';

const WORKER_SCRIPT = fileURLToPath(new URL('./python/worker.py', import.meta.url));

export interface RvcWorldOptions {
  cfg: RvcConfigSection;
  dataDir: string;
  packageDir: string;
  /** `<部署根>/runtimes`；自动找 gpt-sovits 运行时用。 */
  runtimesRoot: () => string;
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
  } | null = null;
  /** 最近一次「重新混音」的结果，面板渲染用。 */
  private lastMix: { at: number; ms: number; bytes: number; savedPath: string | null; format: string; peakScale?: number } | null = null;
  /** 最近一次「重跑选段」的结果，面板渲染用。 */
  private lastRange: { at: number; ms: number; bytes: number; savedPath: string | null; format: string; start: number; end: number; pitch: number } | null = null;
  /** 当前打开/最近创建的分轨会话；清理与删除时据此保护。 */
  private activeSession: string | null = null;

  constructor(opts: RvcWorldOptions) {
    this.opts = opts;
  }

  envPromptVars(): Record<string, string> | null {
    return null;
  }

  tools(): [] {
    return [];
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
        { id: 'cover', title: t.coverTitle, description: t.coverHint, getMethods: ['state'] },
        { id: 'voices', title: t.voicesTitle, description: t.voicesHint, getMethods: ['state', 'voices'] },
      ],
      invoke: async (panel, method, args) => this.invoke(panel, method, args),
      // 配置组交给框架自带的配置视图，不各占一个面板。
      config: configGroups(language),
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.log = host.log;
    this.stopped = false;
    // 「随软件自动启动」关掉时，把引擎按「用户手动停过」处理，等面板点启动。
    this.engineHeld = this.opts.cfg.autoStart === false;
    this.launchDetail = '';
    this.setup();
    // 启动时顺手清一次旧会话：只动 sessions，失败不影响启动。
    try { this.gcSessions(); } catch { /* 清理失败留到下次 */ }
    // 就绪可能要十几秒；先让 World 挂上，接口立刻能答 `ready=false`。
    this.bootEngine();
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
      log: this.log ?? undefined,
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelIdle();
    this.installer?.cancel();
    this.venv?.cancel();
    const server = this.server;
    this.server = null;
    await server?.close();
    await this.engine?.stop();
    this.engine = null;
    await this.starting?.catch(() => undefined);
    this.starting = null;
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
    const minutes = Math.max(0, Math.floor(Number(this.opts.cfg.idleMinutes) || 0));
    if (!minutes || this.stopped || this.engineHeld) return;
    const engine = this.engine;
    if (!engine?.ready()) return;
    if (this.job?.phase === 'working') return;
    if (engine.queue() > 0) return;
    this.idleTimer = setTimeout(() => { void this.sleepIdle(); }, minutes * 60_000);
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
   * 回收后自动拉回：只处理「闲置停」这一种停止。
   * 手动停止、未装依赖、启动失败都保持原来的 409/未就绪语义，不在这里偷偷重试。
   */
  async ensureReady(): Promise<void> {
    if (this.stopped || this.engineHeld) return;
    const engine = this.engine;
    if (!engine || engine.ready()) return;
    // 正在执行闲置回收：等 stop() 结束（期间请求排队，不吃 409）。
    if (this.idleSleep) await this.idleSleep.catch(() => undefined);
    // 已经在启动中（自动启动或别的请求触发）：一起等，避免并发请求被 409 打回。
    if (this.starting) await this.starting.catch(() => undefined);
    if (engine.ready()) return;
    if (!this.idleStopped || engine.state().phase !== 'stopped') return;
    this.idleStopped = false;
    this.bootEngine(false);
    await this.starting?.catch(() => undefined);
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
    if (!base64) throw new RvcError('param', '缺少音频内容');
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
      job = readConvertJob({ fields, file: { filename: fileName || 'song.wav', data: Buffer.from(base64, 'base64') } }, { uvr5: true });
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
    const input = join(tmpDir, `${id}${ext}`);
    const output = join(tmpDir, `${id}.${job.format}`);
    writeFileSync(input, job.file);
    this.cancelIdle();
    const at = Date.now();
    const keepStems = this.opts.cfg.keepStems !== false;
    const session = keepStems ? createSession(this.opts.dataDir) : null;
    if (session) this.activeSession = session.id;
    let sessionWritten = false;
    try {
      const done = await engine.cover({
        input,
        output,
        voice: job.voice,
        pitch: job.pitch,
        indexRate: job.indexRate,
        protect: job.protect,
        format: job.format,
        vocalGain,
        chunk: job.chunk,
        sessionDir: session?.dir,
      });
      const audio = readFileSync(output);
      const outDir = join(this.opts.dataDir, 'out');
      mkdirSync(outDir, { recursive: true });
      const savedPath = join(outDir, `cover-${stamp()}.${job.format}`);
      writeFileSync(savedPath, audio);
      if (session) {
        const now = new Date().toISOString();
        const rel = `out/mix-1.${job.format}`;
        writeFileSync(join(session.dir, rel), audio);
        const record: RefineSession = {
          version: 1,
          id: session.id,
          createdAt: now,
          updatedAt: now,
          engine: { kind: 'rvc', voice: job.voice || engine.state().model || '', modelSampleRate: done.modelSampleRate ?? done.sampleRate ?? 0 },
          source: { durationSec: done.durationSec ?? 0, inputPeak: done.inputPeak ?? 0, format: job.format },
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
          },
          outputs: [{ format: job.format, path: rel, at: now }],
        };
        writeSession(this.opts.dataDir, session.id, record);
        sessionWritten = true;
        this.gcSessions();
      }
      this.lastCover = {
        at, ms: done.ms, bytes: audio.length, savedPath,
        voice: job.voice || engine.state().model || '', format: job.format,
        stages: done.stages, peakScale: done.peakScale,
        sessionId: session?.id,
      };
      return { $binary: { mime: job.format === 'mp3' ? 'audio/mpeg' : 'audio/wav', base64: audio.toString('base64') } };
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

    if (!engine.ready()) {
      await this.ensureReady();
      if (!engine.ready()) throw new RvcError('unavailable', engine.state().detail ?? 'RVC 引擎未就绪');
    }

    const { audio, done, path } = await this.mixSession(id, session, {
      format, vocalGainDb, instGainDb, fadeInSec, fadeOutSec,
    }, true);
    this.lastMix = {
      at: Date.now(), ms: done.ms, bytes: audio.length, savedPath: path,
      format, peakScale: done.peakScale,
    };
    this.log?.info('RVC 重新混音完成', { id, format, ms: done.ms });
    return { $binary: { mime: format === 'mp3' ? 'audio/mpeg' : 'audio/wav', base64: audio.toString('base64') } };
  }

  /**
   * 用会话里的 conv + inst 混一次。`record` 为真时写成 `out/mix-<n>` 并记进
   * `session.outputs`（最多留 3 个）；为假时只写固定名 `out/preview.<fmt>` 供试听。
   */
  private async mixSession(
    id: string,
    session: RefineSession,
    opts: { format: 'wav' | 'mp3'; vocalGainDb: number; instGainDb: number; fadeInSec: number; fadeOutSec: number },
    record: boolean,
  ): Promise<{ audio: Buffer; done: ConvertDone; path: string }> {
    const dir = sessionDir(this.opts.dataDir, id);
    const engine = this.engine;
    if (!dir || !engine) throw new RvcError('unavailable', '会话或引擎不可用');
    const vocals = join(dir, session.converted.path);
    const inst = join(dir, session.stems.inst);
    if (!existsSync(vocals) || !existsSync(inst)) {
      throw new RvcError('param', '会话缺少分轨文件，请重新翻唱一次');
    }
    let output: string;
    let rel: string | null = null;
    if (record) {
      // 编号取已有最大值 +1：成品数量被裁到 3 个后，仍不会覆盖同名文件。
      const next = session.outputs.reduce((max, item) => {
        const match = /^out\/mix-(\d+)\./.exec(item.path);
        return match ? Math.max(max, Number(match[1])) : max;
      }, 0) + 1;
      rel = `out/mix-${next}.${opts.format}`;
      output = join(dir, rel);
    } else {
      output = join(dir, 'out', `preview.${opts.format}`);
    }
    this.cancelIdle();
    const done = await engine.remix({
      vocals, inst, output, format: opts.format,
      vocalGain: opts.vocalGainDb, instGain: opts.instGainDb,
      fadeIn: opts.fadeInSec, fadeOut: opts.fadeOutSec,
      rmsRatio: session.mix.rmsRatio,
      mutedRanges: mutedRanges(session.segments),
    });
    const audio = readFileSync(output);
    if (record && rel) {
      session.mix = { ...session.mix, ...opts, peakScale: done.peakScale ?? 1 };
      session.updatedAt = new Date().toISOString();
      session.outputs.push({ format: opts.format, path: rel, at: session.updatedAt });
      // 只留最近 3 个成品，避免反复试听把磁盘撑大。
      while (session.outputs.length > 3) {
        const old = session.outputs.shift();
        if (old) rmSync(join(dir, old.path), { force: true });
      }
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
    const { audio, done, path } = await this.mixSession(id, result.session, {
      format,
      vocalGainDb: result.session.mix.vocalGainDb,
      instGainDb: result.session.mix.instGainDb,
      fadeInSec: result.session.mix.fadeInSec,
      fadeOutSec: result.session.mix.fadeOutSec,
    }, true);
    this.lastRange = {
      at: Date.now(), ms: result.done.ms + done.ms, bytes: audio.length, savedPath: path,
      format, start: result.segment.start, end: result.segment.end, pitch: result.segment.params.pitch,
    };
    return { $binary: { mime: format === 'mp3' ? 'audio/mpeg' : 'audio/wav', base64: audio.toString('base64') } };
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
    const { audio } = await this.mixSession(id, session, {
      format,
      vocalGainDb: clampNumber(raw.vocalGainDb, -24, 24, session.mix.vocalGainDb),
      instGainDb: clampNumber(raw.instGainDb, -24, 24, session.mix.instGainDb),
      fadeInSec: clampNumber(raw.fadeInSec, 0, 30, session.mix.fadeInSec),
      fadeOutSec: clampNumber(raw.fadeOutSec, 0, 30, session.mix.fadeOutSec),
    }, false);
    return { $binary: { mime: format === 'mp3' ? 'audio/mpeg' : 'audio/wav', base64: audio.toString('base64') } };
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

  /** 面板「结果编辑」：会话列表 + 当前会话的混音参数。 */
  private refineState(id = ''): Record<string, unknown> {
    const sessions = listSessions(this.opts.dataDir);
    const has = (value: string): boolean => sessions.some((s) => s.id === value);
    const wanted = id && has(id) ? id : this.activeSession && has(this.activeSession) ? this.activeSession : sessions[0]?.id ?? '';
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
    };
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
  private job: { kind: 'convert' | 'cover' | 'remix' | 'range'; at: number; phase: 'working' | 'done' | 'error'; detail: string; error?: string; ms?: number } | null = null;
  private jobResult: { mime: string; base64: string; savedPath: string | null; ms: number } | null = null;

  private async invoke(panel: string, method: string, args: unknown[] = []): Promise<unknown> {
    if (method === 'state' || method === 'install' || method === 'cancel' || method === 'restart' || method === 'start' || method === 'stop' || method === 'takeResult') {
      if (method === 'install') this.startSetup();
      else if (method === 'cancel') { this.runtime?.cancel(); this.installer?.cancel(); this.venv?.cancel(); }
      else if (method === 'restart') void this.restartEngine();
      else if (method === 'start') this.startEngine();
      else if (method === 'stop') await this.stopEngine();
      else if (method === 'takeResult') {
        const result = this.jobResult;
        this.jobResult = null;
        return result ?? { error: '没有可取的结果' };
      }
      return this.status();
    }
    if (method === 'convert' || method === 'cover' || method === 'remix') {
      this.beginJob(method, args);
      return this.status();
    }
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
    if (method === 'refineState') return this.refineState(String(args[0] ?? ''));
    if (method === 'refinePeaks') return this.peaksFromPanel(String(args[0] ?? ''));
    if (method === 'exportF0') return this.f0FromPanel(String(args[0] ?? ''));
    if (method === 'refinePreview') {
      const raw = (args[1] && typeof args[1] === 'object' ? args[1] : {}) as Record<string, unknown>;
      return this.previewSession(String(args[0] ?? ''), raw);
    }
    if (method === 'sessionDelete') return this.deleteSession(String(args[0] ?? ''));
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
    return { error: `unknown method: ${panel}.${method}` };
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
    kind: 'convert' | 'cover' | 'remix' | 'range',
    args: unknown[],
    action: 'convert' | 'cover' | 'remix' | 'range' | 'segmentRedo' | 'segmentRevert' = kind,
  ): void {
    if (this.job?.phase === 'working') throw new RvcError('param', '已有任务在跑，等它结束再试');
    const at = Date.now();
    const detail = action === 'cover' ? '分离人声'
      : action === 'range' ? '重跑选段'
        : action === 'segmentRedo' ? '重做段落'
          : action === 'segmentRevert' ? '还原段落'
            : action === 'remix' ? '重新混音' : '变声';
    this.job = { kind, at, phase: 'working', detail };
    this.jobResult = null;
    const task = action === 'cover'
      ? this.coverFromPanel(args)
      : action === 'range'
        ? this.rangeFromPanel(args)
        : action === 'segmentRedo'
          ? this.segmentFromPanel(args, 'redo')
          : action === 'segmentRevert'
            ? this.segmentFromPanel(args, 'revert')
            : action === 'remix'
              ? this.remixFromPanel(args)
              : this.convertFromPanel(args);
    task.then((res) => {
      const bin = (res as { $binary?: { mime: string; base64: string } }).$binary;
      const last = kind === 'cover' ? this.lastCover
        : kind === 'range' ? this.lastRange
          : kind === 'remix' ? this.lastMix
            : this.lastConvert;
      if (bin) {
        this.jobResult = { mime: bin.mime, base64: bin.base64, savedPath: last?.savedPath ?? null, ms: last?.ms ?? 0 };
        this.job = { kind, at, phase: 'done', detail: '完成', ms: last?.ms ?? 0 };
      } else {
        this.job = { kind, at, phase: 'error', detail: '失败', error: '没有拿到音频' };
      }
    }).catch((err) => {
      this.job = { kind, at, phase: 'error', detail: '失败', error: err instanceof Error ? err.message : String(err) };
    }).finally(() => {
      // 任务结束后再排期：`armIdle()` 在 job 还是 working 时会直接返回。
      this.armIdle();
    });
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
      venv: this.venv?.state() ?? { phase: 'absent', detail: 'World 未启动' },
      install: this.installer?.state() ?? { phase: 'absent', done: 0, total: 0, detail: 'World 未启动' },
      voiceCount: voices.length,
      defaultVoice: this.defaultVoice(voices),
      lastConvert: this.lastConvert,
      lastCover: this.lastCover,
      lastMix: this.lastMix,
      lastRange: this.lastRange,
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
