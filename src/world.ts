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
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Language } from 'cortico/core/language.ts';
import type { Logger, World, WorldHost, WorldLamp, WorldWebUiDecl } from 'cortico/core/types.ts';
import { configGroups, DEFAULT_PORT, RVC_ID, worldLabel, type RvcConfigSection, type RvcTier } from './config.ts';
import { RvcEngine, RvcError, type EngineState } from './engine.ts';
import { RvcInstaller } from './install.ts';
import { readConvertJob, startConvertServer, type ConvertDeps, type ConvertJob, type ConvertServerHandle } from './server.ts';
import { RvcVenv } from './venv.ts';
import { importVoiceFile, listVoices } from './voices.ts';
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

/** 推理代码里有没有 `tools/uvr5`：没有就把 `separator=uvr5` 标成不可用。 */
export function hasUvr5(codeDir: string): boolean {
  return !!codeDir && existsSync(join(codeDir, 'tools', 'uvr5'));
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
  private launchDetail = '';
  private codeDir = '';
  private assetsDir = '';
  private voicesDir = '';
  private pythonPath = '';
  private runtimeDir = '';
  /** 实际用的运行时档（`''` 表示自备运行时，判断不了）。 */
  private runtimeTier: 'cuda' | 'cpu' | '' = '';
  /** 最近一次面板转换的结果，面板渲染用。 */
  private lastConvert: { at: number; ms: number; bytes: number; savedPath: string | null; voice: string; format: string } | null = null;

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
    this.launchDetail = '';
    this.setup();
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
    this.pythonPath = paths.pythonPath;
    this.runtimeDir = paths.runtimeDir;
    this.runtimeTier = paths.runtimeTier;
    this.installer = new RvcInstaller(paths.assetsDir, paths.voicesDir);
    this.venv = new RvcVenv({
      pythonPath: paths.pythonPath,
      basePython: paths.runtimeDir ? join(paths.runtimeDir, 'runtime', 'python.exe') : '',
      log: this.log ?? undefined,
    });
    this.engine = new RvcEngine({
      pythonPath: paths.pythonPath,
      codeDir: paths.codeDir,
      voicesDir: paths.voicesDir,
      assetsDir: paths.assetsDir,
      scriptPath: WORKER_SCRIPT,
      voice: this.opts.cfg.voice.trim() || firstVoice(paths.voicesDir),
      runtimeDir: paths.runtimeDir || undefined,
      log: this.log ?? undefined,
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
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

  /** 拉起/重拉引擎；失败原因进 `launchDetail`，面板与接口据此解释。 */
  private bootEngine(): void {
    const engine = this.engine;
    if (!engine) return;
    this.starting = engine.start()
      .then(() => { this.launchDetail = ''; })
      .catch((err: unknown) => {
        this.launchDetail = err instanceof Error ? err.message : String(err);
        this.log?.warn('RVC 引擎启动失败', { err: this.launchDetail });
      });
    void this.starting;
  }

  /** 面板/接口共用：此刻引擎状态。 */
  health(): { ready: boolean; device: string | null; model: string | null } {
    const st = this.engine?.state();
    return { ready: !!this.engine?.ready(), device: st?.device ?? null, model: st?.model ?? null };
  }

  private paths(): { codeDir: string; pythonPath: string; runtimeDir: string; runtimeTier: 'cuda' | 'cpu' | ''; voicesDir: string; assetsDir: string } {
    const dataDir = this.opts.dataDir;
    // 自备运行时判断不了档位；托管运行时按配置的推理档挑（auto 优先 CUDA）。
    const own = this.opts.cfg.runtimeDir.trim();
    const picked = own
      ? { dir: own, tier: '' as const }
      : findRuntimeDir(this.opts.runtimesRoot(), this.opts.cfg.tier);
    return {
      // 代码随包走（vendor/rvc，只读）；权重与音色在数据目录。
      codeDir: this.opts.cfg.codeDir.trim() || join(this.opts.packageDir, 'vendor', 'rvc'),
      assetsDir: this.opts.cfg.assetsDir.trim() || join(dataDir, 'assets'),
      pythonPath: this.opts.cfg.pythonPath.trim() || join(dataDir, 'venv', 'Scripts', 'python.exe'),
      runtimeDir: picked.dir,
      runtimeTier: picked.tier,
      voicesDir: this.opts.cfg.voicesDir.trim() || join(dataDir, 'voices'),
    };
  }

  private async startHttp(): Promise<void> {
    const deps: ConvertDeps = {
      ready: () => !!this.engine?.ready(),
      stateText: () => this.engine?.state().detail ?? (this.launchDetail || 'RVC 引擎启动中'),
      health: () => this.health(),
      uvr5: () => hasUvr5(this.codeDir),
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

  /** 一次转换：临时文件进、临时文件出；`save=1` 时另存到 `<dataDir>/out`。 */
  private async convert(job: ConvertJob): Promise<{ audio: Buffer; savedPath?: string }> {
    const engine = this.engine;
    if (!engine) throw new RvcError('unavailable', 'RVC 引擎未启动');
    const tmpDir = join(this.opts.dataDir, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const id = randomUUID();
    const ext = extname(job.filename).toLowerCase() || '.wav';
    const input = join(tmpDir, `${id}${ext}`);
    const output = join(tmpDir, `${id}.${job.format}`);
    writeFileSync(input, job.file);
    const at = Date.now();
    try {
      const done = await engine.convert({
        input,
        output,
        voice: job.voice,
        pitch: job.pitch,
        indexRate: job.indexRate,
        protect: job.protect,
        format: job.format,
      });
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
      rmSync(output, { force: true });
    }
  }

  private async invoke(panel: string, method: string, args: unknown[] = []): Promise<unknown> {
    if (method === 'state' || method === 'install' || method === 'cancel' || method === 'restart') {
      if (method === 'install') this.startSetup();
      else if (method === 'cancel') { this.installer?.cancel(); this.venv?.cancel(); }
      else if (method === 'restart') void this.restartEngine();
      return this.status();
    }
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
    if (method === 'convert') return this.convertFromPanel(args);
    return { error: `unknown method: ${panel}.${method}` };
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
      pythonPath: this.pythonPath,
      runtimeDir: this.runtimeDir,
      uvr5: hasUvr5(this.codeDir),
      venv: this.venv?.state() ?? { phase: 'absent', detail: 'World 未启动' },
      install: this.installer?.state() ?? { phase: 'absent', done: 0, total: 0, detail: 'World 未启动' },
      voiceCount: voices.length,
      defaultVoice: this.defaultVoice(voices),
      lastConvert: this.lastConvert,
    };
  }

  /** 默认音色：配置里写的，没写就是目录里第一个。 */
  private defaultVoice(voices: ReturnType<typeof listVoices>): string {
    return this.opts.cfg.voice.trim() || voices[0]?.name || '';
  }

  /** 面板点「一键安装」：先停引擎，再建派生 venv、补依赖、下权重，装完自动重拉引擎。 */
  private startSetup(): void {
    const installer = this.installer;
    const venv = this.venv;
    if (!installer || !venv) return;
    if (venv.state().phase === 'working' || installer.state().phase === 'working') return;
    void (async () => {
      // worker 在跑时会占住 venv 里的 .pyd/.dll，pip 覆盖不了这些文件；先停掉再装。
      await this.engine?.stop();
      if (this.stopped) return;
      await venv.ensure();
      if (this.stopped) return;
      if (venv.state().phase !== 'ready') {
        this.log?.warn('RVC 依赖没装好，先不下载权重', { detail: venv.state().detail });
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
    await this.engine?.stop();
    if (this.stopped) return;
    // 可能改过推理档/运行时：按当前配置重建 venv 与引擎（venv 的 base 变了会自动重建）。
    this.setup();
    const venv = this.venv;
    if (!venv) return;
    await venv.check();
    if (this.stopped) return;
    if (venv.state().phase === 'ready') {
      this.bootEngine();
      return;
    }
    // 切了推理档或依赖没装：重建派生 venv，装完再拉起引擎，面板能看到「安装中」。
    void venv.ensure().then(() => {
      if (!this.stopped && venv.state().phase === 'ready') this.bootEngine();
    });
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
    for (const key of ['voice', 'pitch', 'indexRate', 'protect', 'format', 'separator']) {
      const value = raw[key];
      if (value !== undefined && value !== null && value !== '') fields[key] = String(value);
    }
    // 先按接口同一套规则校验参数，再问引擎：填错了立刻能看到原因。
    let job: ConvertJob;
    try {
      job = readConvertJob({ fields, file: { filename: fileName || 'input.wav', data: Buffer.from(base64, 'base64') } }, { uvr5: hasUvr5(this.codeDir) });
    } catch (err) {
      throw new RvcError('param', err instanceof Error ? err.message : String(err));
    }
    if (!engine.ready()) throw new RvcError('unavailable', engine.state().detail ?? 'RVC 引擎未就绪');
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

const silentLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, emit: () => {},
  child: () => silentLogger,
};
