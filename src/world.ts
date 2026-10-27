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
import { configGroups, DEFAULT_PORT, RVC_ID, worldLabel, type RvcConfigSection } from './config.ts';
import { RvcEngine, RvcError, type EngineState } from './engine.ts';
import { startConvertServer, type ConvertDeps, type ConvertJob, type ConvertServerHandle } from './server.ts';

const WORKER_SCRIPT = fileURLToPath(new URL('./python/worker.py', import.meta.url));

export interface RvcWorldOptions {
  cfg: RvcConfigSection;
  dataDir: string;
  packageDir: string;
  /** `<部署根>/runtimes`；自动找 gpt-sovits 运行时用。 */
  runtimesRoot: () => string;
}

/** 在 `<runtimesRoot>/gpt-sovits/<版本>/<档>/runtime/python.exe` 里挑一个最新的可用运行时。 */
export function findRuntimeDir(runtimesRoot: string): string {
  const root = join(runtimesRoot, 'gpt-sovits');
  if (!existsSync(root)) return '';
  let best = '';
  let bestTime = 0;
  let versions: string[] = [];
  try { versions = readdirSync(root); } catch { return ''; }
  for (const version of versions) {
    for (const tier of ['cuda', 'cpu']) {
      const dir = join(root, version, tier);
      if (!existsSync(join(dir, 'runtime', 'python.exe'))) continue;
      let time = 0;
      try { time = statSync(join(dir, 'cortico-runtime.json')).mtimeMs; } catch { time = statSync(dir).mtimeMs; }
      if (time > bestTime) { best = dir; bestTime = time; }
    }
  }
  return best;
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

export class RvcWorld implements World {
  readonly id = RVC_ID;
  private readonly opts: RvcWorldOptions;
  private log: Logger | null = null;
  private engine: RvcEngine | null = null;
  private server: ConvertServerHandle | null = null;
  private starting: Promise<void> | null = null;
  private stopped = true;
  private launchDetail = '';

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
    const lamp: WorldLamp = {
      label: 'RVC',
      state: st?.phase === 'ready' ? 'online' : st?.phase === 'starting' ? 'loading' : st?.phase === 'error' ? 'error' : 'offline',
      hint: this.launchDetail || st?.detail || undefined,
    };
    return {
      label: worldLabel(language),
      lamps: [lamp],
      panels: [
        { id: 'service', title: worldLabel(language), description: 'RVC 推理服务状态与接口信息。', getMethods: ['state'] },
        ...configGroups(language).map((group) => ({
          id: group.id.replace(/^world:/, ''),
          title: (group.schema as { title?: string }).title ?? group.id,
          description: (group.schema as { description?: string }).description ?? '',
          getMethods: ['config'],
        })),
      ],
      invoke: async (panel, method) => this.invoke(panel, method),
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.log = host.log;
    this.stopped = false;
    this.launchDetail = '';
    const paths = this.paths();
    this.engine = new RvcEngine({
      pythonPath: paths.pythonPath,
      codeDir: paths.codeDir,
      voicesDir: paths.voicesDir,
      scriptPath: WORKER_SCRIPT,
      voice: this.opts.cfg.voice.trim() || firstVoice(paths.voicesDir),
      runtimeDir: paths.runtimeDir || undefined,
      log: this.log,
    });
    // 就绪可能要十几秒；先让 World 挂上，接口立刻能答 `ready=false`。
    this.starting = this.engine.start().catch((err: unknown) => {
      this.launchDetail = err instanceof Error ? err.message : String(err);
      this.log?.warn('RVC 引擎启动失败', { err: this.launchDetail });
    });
    void this.starting;
    if (this.opts.cfg.httpApi) void this.startHttp();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const server = this.server;
    this.server = null;
    await server?.close();
    await this.engine?.stop();
    this.engine = null;
    await this.starting?.catch(() => undefined);
    this.starting = null;
  }

  /** 面板/接口共用：此刻引擎状态。 */
  health(): { ready: boolean; device: string | null; model: string | null } {
    const st = this.engine?.state();
    return { ready: !!this.engine?.ready(), device: st?.device ?? null, model: st?.model ?? null };
  }

  private paths(): { codeDir: string; pythonPath: string; runtimeDir: string; voicesDir: string } {
    const dataDir = this.opts.dataDir;
    const runtimeDir = this.opts.cfg.runtimeDir.trim() || findRuntimeDir(this.opts.runtimesRoot());
    return {
      codeDir: this.opts.cfg.codeDir.trim() || join(dataDir, 'rvc'),
      pythonPath: this.opts.cfg.pythonPath.trim() || join(dataDir, 'venv', 'Scripts', 'python.exe'),
      runtimeDir,
      voicesDir: this.opts.cfg.voicesDir.trim() || join(dataDir, 'voices'),
    };
  }

  private async startHttp(): Promise<void> {
    const deps: ConvertDeps = {
      ready: () => !!this.engine?.ready(),
      stateText: () => this.engine?.state().detail ?? (this.launchDetail || 'RVC 引擎启动中'),
      health: () => this.health(),
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
    try {
      await engine.convert({
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
      return { audio, savedPath };
    } finally {
      rmSync(input, { force: true });
      rmSync(output, { force: true });
    }
  }

  private async invoke(panel: string, method: string): Promise<unknown> {
    if (method === 'state') {
      const st: EngineState | null = this.engine ? this.engine.state() : null;
      return {
        phase: st?.phase ?? 'stopped',
        ready: this.health().ready,
        device: st?.device ?? null,
        model: st?.model ?? null,
        queue: this.engine?.queue() ?? 0,
        port: this.server?.port ?? (this.opts.cfg.httpApi ? this.opts.cfg.httpPort : null),
        detail: st?.detail ?? this.launchDetail,
        tail: this.engine?.output() ?? [],
      };
    }
    return { error: `unknown method: ${panel}.${method}` };
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
