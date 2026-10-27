/**
 * 常驻 RVC 推理 worker（`src/python/worker.py`）的 Node 侧控制器。
 *
 * worker 是**常驻**子进程：启动时载入模型并预热一次，之后每来一条请求只读一行 JSON、
 * 写一行 JSON。这样热态 0.3 秒左右，不必每条请求都付 17 秒冷启动。
 *
 * 协议（stdin/stdout 各一行 JSON，UTF-8 无缓冲）：
 * - worker → engine：`{"type":"ready","device":"cuda:0","model":"daifeiyu","warn":"..."}`
 * - worker → engine：`{"type":"result","id":1,"ok":true,"ms":123,"sampleRate":40000}`
 * - worker → engine：`{"type":"result","id":1,"ok":false,"kind":"decode|infer","error":"..."}`
 * - engine → worker：`{"op":"convert","id":1,"input":"...","output":"...","voice":"...","pitch":0,...}`
 * - engine → worker：`{"op":"shutdown"}`
 * worker 的日志一律走 stderr，stdout 只放协议行。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';

export class RvcError extends Error {
  constructor(readonly kind: 'param' | 'decode' | 'infer' | 'unavailable', message: string) {
    super(message);
    this.name = 'RvcError';
  }
}

export interface EngineOptions {
  /** 派生 venv 的 python.exe。 */
  pythonPath: string;
  /** RVC 推理代码目录（包内 `vendor/rvc`，只读）。 */
  codeDir: string;
  /** 音色权重目录。 */
  voicesDir: string;
  /** 模型资产目录（`hubert_base/`、`rmvpe/`）。 */
  assetsDir: string;
  /** worker.py 的绝对路径。 */
  scriptPath: string;
  /** 启动时就载入的音色（.pth 文件名去掉扩展名）；空为目录里第一个。 */
  voice?: string;
  /** base 运行时目录，只为把它的 `runtime` 放进 PATH（CUDA / ffmpeg 依赖）。 */
  runtimeDir?: string;
  /** 单次转换上限；超时杀 worker 并报推理失败。 */
  timeoutMs?: number;
  /** 启动到就绪（含预热）的上限。 */
  startTimeoutMs?: number;
  log?: Logger;
}

export type EnginePhase = 'stopped' | 'starting' | 'ready' | 'error';

export interface EngineState {
  phase: EnginePhase;
  device: string | null;
  model: string | null;
  pid: number | null;
  detail: string | null;
  startMs: number | null;
}

export interface ConvertRequest {
  input: string;
  output: string;
  /** 空为启动时载入的音色。 */
  voice?: string;
  pitch: number;
  indexRate: number;
  protect: number;
  format: 'wav' | 'mp3';
}

export interface ConvertDone {
  ms: number;
  sampleRate: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_START_TIMEOUT_MS = 180_000;
const TAIL_LINES = 40;

interface Pending {
  resolve: (done: ConvertDone) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class RvcEngine {
  private child: ChildProcess | null = null;
  private st: EngineState = { phase: 'stopped', device: null, model: null, pid: null, detail: null, startMs: null };
  private tail: string[] = [];
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  /** 就绪前的启动等待者。 */
  private readyWaiters: { resolve: () => void; reject: (err: Error) => void } | null = null;
  /** 最近的 worker 输出行，失败时给操作者看。 */
  private buf = '';
  /** 串行链：一次只让 worker 转一条。 */
  private tailChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: EngineOptions) {}

  state(): EngineState {
    return { ...this.st };
  }

  /** 最近一行输出，面板/日志用。 */
  output(): string[] {
    return [...this.tail];
  }

  ready(): boolean {
    return this.st.phase === 'ready' && this.child !== null;
  }

  /** 正在处理的请求数（含排队）。 */
  queue(): number {
    return this.pending.size;
  }

  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.st.phase === 'ready') return Promise.resolve();
    this.starting = (async () => {
      if (this.stopping) await this.stopping;
      await this.launch();
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  async stop(): Promise<void> {
    this.readyWaiters?.reject(new RvcError('unavailable', 'RVC 引擎已停止'));
    this.readyWaiters = null;
    this.failPending(new RvcError('unavailable', 'RVC 引擎已停止'));
    const child = this.child;
    this.child = null;
    this.st = { phase: 'stopped', device: null, model: null, pid: null, detail: null, startMs: null };
    if (!child?.pid || child.exitCode !== null) return;
    const done = new Promise<void>((finish) => {
      child.once('exit', () => finish());
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGTERM');
      setTimeout(finish, 5000).unref();
    });
    this.stopping = done;
    try {
      await done;
    } finally {
      if (this.stopping === done) this.stopping = null;
    }
  }

  /** 转一条；引擎未就绪时抛 `unavailable`，worker 报解码失败为 `decode`，其余为 `infer`。 */
  async convert(req: ConvertRequest): Promise<ConvertDone> {
    if (!this.ready()) throw new RvcError('unavailable', this.st.detail ?? 'RVC 引擎未就绪');
    const id = ++this.seq;
    const run = () => new Promise<ConvertDone>((resolve, reject) => {
      const child = this.child;
      if (!child?.stdin?.writable) { reject(new RvcError('unavailable', 'RVC worker 已退出')); return; }
      const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RvcError('infer', `RVC 推理超过 ${Math.round(timeoutMs / 1000)} 秒`));
        void this.stop();
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      const line = JSON.stringify({
        op: 'convert', id,
        input: req.input, output: req.output, voice: req.voice ?? '',
        pitch: req.pitch, indexRate: req.indexRate, protect: req.protect, format: req.format,
      });
      try {
        child.stdin.write(`${line}\n`);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new RvcError('infer', err instanceof Error ? err.message : String(err)));
      }
    });
    const next = this.tailChain.then(run, run);
    this.tailChain = next.catch(() => undefined);
    return next;
  }

  private async launch(): Promise<void> {
    const started = Date.now();
    this.tail = [];
    this.buf = '';
    this.st = { phase: 'starting', device: null, model: null, pid: null, detail: null, startMs: null };
    const python = this.opts.pythonPath;
    const script = this.opts.scriptPath;
    const child = spawn(python, [script, this.opts.codeDir, this.opts.voicesDir, this.opts.assetsDir], {
      cwd: this.opts.codeDir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        // 代码目录在扩展包里，别在里面写 __pycache__。
        PYTHONDONTWRITEBYTECODE: '1',
        RVC_DEFAULT_VOICE: this.opts.voice ?? '',
        PATH: this.searchPath(),
      },
    });
    this.child = child;
    this.st = { phase: 'starting', device: null, model: null, pid: child.pid ?? null, detail: null, startMs: null };
    child.stdout!.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr!.on('data', (chunk: Buffer) => this.onStderr(chunk));
    child.on('error', (err) => this.onExit(child, `启动失败：${err.message}`));
    child.on('exit', (code) => this.onExit(child, `RVC worker 退出（${code}）`));

    const ready = new Promise<void>((resolve, reject) => {
      this.readyWaiters = { resolve, reject };
      const timer = setTimeout(() => {
        if (this.child !== child || this.st.phase !== 'starting') return;
        reject(new RvcError('unavailable', `RVC worker ${Math.round((this.opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS) / 1000)} 秒内没有就绪`));
        void this.stop();
      }, this.opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
      timer.unref();
    });
    try {
      await ready;
      this.st = { ...this.st, phase: 'ready', startMs: Date.now() - started };
      this.opts.log?.info('RVC 引擎就绪', { device: this.st.device, model: this.st.model, ms: this.st.startMs });
    } catch (err) {
      this.st = { ...this.st, phase: 'error', detail: err instanceof Error ? err.message : String(err) };
      this.opts.log?.warn('RVC 引擎没能就绪', { err: this.st.detail, tail: this.tail.slice(-5) });
      throw err;
    }
  }

  private searchPath(): string {
    const dirs = [dirname(this.opts.pythonPath)];
    if (this.opts.runtimeDir) dirs.push(join(this.opts.runtimeDir, 'runtime'));
    return [...dirs, process.env.PATH ?? ''].join(';');
  }

  private onStdout(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
    let at = this.buf.indexOf('\n');
    while (at >= 0) {
      const line = this.buf.slice(0, at).trim();
      this.buf = this.buf.slice(at + 1);
      if (line) this.onLine(line);
      at = this.buf.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.pushTail(line);
      return;
    }
    if (msg.type === 'ready') {
      this.st = {
        ...this.st,
        device: typeof msg.device === 'string' ? msg.device : null,
        model: typeof msg.model === 'string' && msg.model ? msg.model : null,
      };
      if (msg.warn) this.opts.log?.warn('RVC 预热未完成，先按就绪处理', { warn: msg.warn });
      const waiter = this.readyWaiters;
      this.readyWaiters = null;
      waiter?.resolve();
      return;
    }
    if (msg.type === 'fatal') {
      // worker 启动即失败（代码或资产缺失）：立刻报错，不等到超时。
      const why = typeof msg.error === 'string' && msg.error ? msg.error : 'RVC worker 启动失败';
      this.st = { ...this.st, phase: 'error', detail: why };
      const waiter = this.readyWaiters;
      this.readyWaiters = null;
      waiter?.reject(new RvcError('unavailable', why));
      return;
    }
    if (msg.type === 'result') {
      const id = typeof msg.id === 'number' ? msg.id : -1;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (msg.ok) {
        pending.resolve({
          ms: typeof msg.ms === 'number' ? msg.ms : 0,
          sampleRate: typeof msg.sampleRate === 'number' ? msg.sampleRate : 0,
        });
      } else {
        const kind = msg.kind === 'decode' ? 'decode' : msg.kind === 'param' ? 'param' : 'infer';
        pending.reject(new RvcError(kind, typeof msg.error === 'string' && msg.error ? msg.error : 'RVC 推理失败'));
      }
      return;
    }
    this.pushTail(line);
  }

  private onStderr(chunk: Buffer): void {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim()) this.pushTail(line.trim());
    }
  }

  private pushTail(line: string): void {
    this.tail.push(line.slice(0, 300));
    if (this.tail.length > TAIL_LINES) this.tail.shift();
    this.opts.log?.debug('rvc worker', { line: line.slice(0, 300) });
  }

  private onExit(child: ChildProcess, detail: string): void {
    if (this.child !== child) return;
    this.child = null;
    const reason = this.st.detail ? `（${this.st.detail}）` : '';
    const err = new RvcError('unavailable', `${detail}${reason}：${this.tail.slice(-3).join(' | ') || '无输出'}`);
    if (this.st.phase === 'starting') {
      this.st = { ...this.st, phase: 'error', detail: err.message };
      const waiter = this.readyWaiters;
      this.readyWaiters = null;
      waiter?.reject(err);
    } else {
      this.st = { ...this.st, phase: 'error', detail: err.message };
    }
    this.failPending(err);
  }

  private failPending(err: RvcError): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
