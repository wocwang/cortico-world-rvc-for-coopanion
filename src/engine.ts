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
 * - engine → worker：`{"op":"separate","id":2,"input":"...","output":"..."}`
 * - engine → worker：`{"op":"cover","id":3,"input":"...","output":"...","voice":"...","vocalGain":0,...}`
 * - engine → worker：`{"op":"remix","id":4,"vocals":"...","inst":"...","output":"..."}`
 * - engine → worker：`{"op":"shutdown"}`
 * worker 的日志一律走 stderr，stdout 只放协议行。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  /** 人声分离模型（`UVR-MDX-NET-Inst_HQ_3.onnx`）；空表示没装。 */
  uvrModel?: string;
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
  /** 静音门：默认开；false 时 worker 原样输出（等于 RVC_SILENCE_GATE=0）。 */
  silenceGate?: boolean;
  /** 气声保护：默认开；false 时 worker 原样输出（等于 RVC_BREATH_GUARD=0）。 */
  breathGuard?: boolean;
  /** 高音幻觉保护：默认开；false 时 worker 原样输出（等于 RVC_HIGH_GUARD=0）。 */
  highGuard?: boolean;
  prePurify?: boolean;
  highRescue?: boolean;
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
  /** 长音频是否切片（默认切）；关掉就整段一次进模型，快但吃显存。 */
  chunk?: boolean;
}

/** 整首歌：分离 → 变声 → 混回。 */
export interface CoverRequest {
  input: string;
  output: string;
  voice?: string;
  pitch: number;
  indexRate: number;
  protect: number;
  format: 'wav' | 'mp3';
  /** 人声增益，分贝；0 为按原人声电平混。 */
  vocalGain?: number;
  /** 长音频是否切片（默认切）。 */
  chunk?: boolean;
  /** 翻唱会话目录；给了就把分轨与变声结果留在里面，不给则沿用旧行为（不落盘）。 */
  sessionDir?: string;
  /** 是否带 BGM；false 时只写清唱（单声道 WAV）。默认 true。 */
  withBgm?: boolean;
  /** 分离档位：high 用 Mel-Band RoFormer，缺权重/显存不足时 worker 回退 fast。 */
  sepModel?: 'fast' | 'high';
  /** 高质量权重路径（sepModel=high 时用）。 */
  melbandModel?: string;
}

/** 复用已分离的人声分轨重跑整首变声，原地替换 conv.wav。 */
export interface ReconvertRequest {
  /** 已分离的人声（44.1 kHz）。 */
  stem: string;
  /** 伴奏（44.1 kHz），只用来校准长度。 */
  inst: string;
  /** 旧变声结果，会被原地替换；替换前备份成 `conv.bak.wav`。 */
  conv: string;
  voice?: string;
  pitch: number;
  indexRate: number;
  protect: number;
  chunk?: boolean;
  /** 会话里记录的整首时长；分轨与它对不上就中止，不覆盖成品。 */
  expectedSec?: number;
}

export interface SeparateRequest {
  input: string;
  /** 人声输出路径。 */
  output: string;
  /** 伴奏输出路径；空则不写。 */
  instrumental?: string;
}

/** 只做文件级混音：读已分离好的伴奏与变声后人声，按增益/淡入淡出混成一条。 */
export interface RemixRequest {
  /** 变声后人声（44.1 kHz mono）。 */
  vocals: string;
  /** 伴奏（44.1 kHz stereo）。 */
  inst: string;
  output: string;
  format: 'wav' | 'mp3';
  /** 人声增益，分贝。 */
  vocalGain: number;
  /** 伴奏增益，分贝。 */
  instGain: number;
  fadeIn: number;
  fadeOut: number;
  /** 首次翻唱算出的 RMS 比例；冻结使用，避免局部重跑后整首电平跳变。 */
  rmsRatio: number;
  /** 静音段落：区间内人声乘 0，伴奏不动。 */
  mutedRanges?: Array<{ start: number; end: number }>;
}

/** 只渲染清唱：读变声后人声，按 rmsRatio / vocalGain 对齐响度，输出单声道 WAV。 */
export interface VocalOnlyRequest {
  vocals: string;
  output: string;
  vocalGain: number;
  fadeIn: number;
  fadeOut: number;
  rmsRatio: number;
  mutedRanges?: Array<{ start: number; end: number }>;
}

export interface ConvertDone {
  ms: number;
  sampleRate: number;
  /** 整首歌流程的分段耗时：分离 / 变声 / 混音（毫秒）。 */
  stages?: { separate?: number; convert?: number; mix?: number };
  /** 混音时为了不削波整体缩小的倍率（1 表示没缩）。 */
  peakScale?: number;
  /** 翻唱：分离人声的 16 kHz 峰值，后续区间重跑复现音量用。 */
  inputPeak?: number;
  /** 翻唱：RVC 模型原始输出的采样率（重采样到 44.1 kHz 之前）。 */
  modelSampleRate?: number;
  /** 翻唱：人声与变声结果的 RMS 比例，混音与重混都用它。 */
  rmsRatio?: number;
  /** 翻唱/重混：成品时长（秒）。 */
  durationSec?: number;
  /** 这次成品是否带 BGM。 */
  withBgm?: boolean;
  /** 实际用的分离模型：mel_band（高质量）或 mdx（默认）。 */
  separator?: 'mel_band' | 'mdx';
  /** 高质量回退等说明；为空表示没有降级。 */
  separatorNote?: string;
  /** 清唱输出的声道数（1）。 */
  channels?: number;
  /** 区间重跑：实际拼回的样本区间与预期长度。 */
  spliced?: { start: number; end: number; expected: number };
  /** 区间重跑：峰值补偿倍率（只衰减不放大）。 */
  peakFactor?: number;
  /** 区间重跑：这次是否新建了段落备份。 */
  backedUp?: boolean;
  /** 段落还原：实际复写的样本区间。 */
  restored?: { start: number; end: number };
  /** 波形包络：每个桶的 min/max 与总帧数。 */
  peaks?: { buckets: number; frames: number; min: number[]; max: number[] };
  /** 音高导出：帧数、帧率与时长。 */
  frames?: number;
  frameRate?: number;
  /** 母带：处理前后实测的响度与真峰值。 */
  loudness?: LoudnessReport;
}

/** 只重跑一段时间：读会话人声分轨的窗口，换参数重渲后拼回 conv。 */
export interface RangeConvertRequest {
  /** 分离人声（44.1 kHz）。 */
  stem: string;
  /** 变声结果（44.1 kHz mono），原地改写。 */
  conv: string;
  startSec: number;
  endSec: number;
  /** 窗口上下文（秒，默认 0.5）；只用于给模型听感，不写回。 */
  contextSec?: number;
  /** 选区边缘交叉淡化（秒，默认 0.3），在选区内部完成。 */
  seamSec?: number;
  outSr?: number;
  voice?: string;
  pitch: number;
  indexRate: number;
  protect: number;
  /** 首次翻唱的整轨输入峰值；用于复现同样的音量。 */
  inputPeak: number;
  /** 段落首次重做前写一份原始音频到这里；已存在则不覆盖。 */
  backupPath?: string;
}

/** 用段落备份逐样本还原 conv 的一段（不做淡化、不跑模型）。 */
export interface RestoreRangeRequest {
  conv: string;
  backup: string;
  /** 整数样本。 */
  start: number;
  end: number;
}

export interface PeaksRequest {
  path: string;
  /** 包络桶数（默认 1200）。 */
  buckets?: number;
}

export interface PeaksDone {
  sampleRate: number;
  frames: number;
  durationSec: number;
  buckets: number;
  min: number[];
  max: number[];
}

/** 只读导出音高：对分离人声跑一次 RMVPE，写 `time,f0` CSV。 */
export interface F0Request {
  input: string;
  output: string;
  /** 静音阈值（默认 0.03，与 run_vc 的 RMVPE 提取一致）。 */
  threshold?: number;
}

export interface F0Done {
  ms: number;
  frames: number;
  frameRate: number;
  durationSec: number;
}

/** 母带：按目标响度整体增益 + 真峰值限幅；只读文件，不跑模型。 */
export interface MasterRequest {
  /** 输入混音（任意采样率/声道，worker 会解码成 44.1 kHz 立体声）。 */
  input: string;
  /** 另存路径；不会覆盖输入。 */
  output: string;
  format: 'wav' | 'mp3';
  /** 目标积分响度，只接受 -14 / -16 / -23。 */
  targetLufs: number;
  /** 真峰值上限（默认 -1 dBTP）。 */
  ceilingDb?: number;
}

/** 母带实测：处理前后的 LUFS 与 4 倍过采样真峰值。 */
export interface LoudnessReport {
  targetLufs: number;
  ceilingDb: number;
  inputLufs: number;
  inputTruePeakDb: number;
  outputLufs: number;
  outputTruePeakDb: number;
  gainDb: number;
  limitedDb: number;
}

export interface MasterDone extends ConvertDone {
  loudness: LoudnessReport;
}

/** 长音频会切片（每 20 秒一片），5 分钟的音频在 CPU 上也可能几分钟，给足上限。 */
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_START_TIMEOUT_MS = 180_000;
/** 分离一首歌要跑完整条 MDX 流（4 分钟约 2 分钟 CPU），单独给长上限。 */
const SEPARATE_TIMEOUT_MS = 900_000;
/** 分离 + 变声 + 混音：一首 4 分钟的歌约 5 分钟，给足余量。 */
const COVER_TIMEOUT_MS = 1_800_000;
/** 重混只读文件、不跑模型；长音频也在秒级到分钟级。 */
const REMIX_TIMEOUT_MS = 300_000;
/** 区间重跑至少给 2 分钟，再按窗口时长加；20 秒窗口不必等 10 分钟。 */
const RANGE_BASE_TIMEOUT_MS = 120_000;
const RANGE_PER_SECOND_MS = 4_000;
/** 波形包络只读文件。 */
const PEAKS_TIMEOUT_MS = 60_000;
/** 段落还原只读备份、写回一段，不跑模型。 */
const RESTORE_TIMEOUT_MS = 120_000;
/** 音高导出要载入 RMVPE（首次约几秒）再跑一遍，给足余量。 */
const F0_TIMEOUT_MS = 300_000;
/** 母带要整首读进内存并做多轮 4 倍过采样，长音频按分钟计。 */
const MASTER_TIMEOUT_MS = 600_000;
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
    return this.run('convert', {
      input: req.input, output: req.output, voice: req.voice ?? '',
      pitch: req.pitch, indexRate: req.indexRate, protect: req.protect, format: req.format,
      chunk: req.chunk === false ? 0 : 1,
    }, this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  /** 只分离（`POST /convert?separator=uvr5` 的第一段）。 */
  async separate(req: SeparateRequest): Promise<ConvertDone> {
    return this.run('separate', {
      input: req.input, output: req.output, instrumental: req.instrumental ?? '',
    }, SEPARATE_TIMEOUT_MS);
  }

  /** 整首歌：分离 → 变声 → 混回。 */
  async cover(req: CoverRequest): Promise<ConvertDone> {
    return this.run('cover', {
      input: req.input, output: req.output, voice: req.voice ?? '',
      pitch: req.pitch, indexRate: req.indexRate, protect: req.protect,
      format: req.format, vocalGain: req.vocalGain ?? 0, chunk: req.chunk === false ? 0 : 1,
      sessionDir: req.sessionDir ?? '', withBgm: req.withBgm === false ? 0 : 1,
      sepModel: req.sepModel ?? 'fast', melbandModel: req.melbandModel ?? '',
    }, COVER_TIMEOUT_MS);
  }

  /** 复用会话分轨重跑整首变声（跳过分离），原地替换 conv.wav。 */
  async reconvert(req: ReconvertRequest): Promise<ConvertDone> {
    return this.run('reconvert', {
      stem: req.stem, inst: req.inst, conv: req.conv, voice: req.voice ?? '',
      pitch: req.pitch, indexRate: req.indexRate, protect: req.protect,
      chunk: req.chunk === false ? 0 : 1, expectedSec: req.expectedSec ?? 0,
    }, COVER_TIMEOUT_MS);
  }

  /** 只重做混音：不重新分离、不变声。 */
  async remix(req: RemixRequest): Promise<ConvertDone> {
    return this.run('remix', {
      vocals: req.vocals, inst: req.inst, output: req.output, format: req.format,
      vocalGain: req.vocalGain, instGain: req.instGain,
      fadeIn: req.fadeIn, fadeOut: req.fadeOut, rmsRatio: req.rmsRatio,
      mutedRanges: req.mutedRanges ?? [],
    }, REMIX_TIMEOUT_MS);
  }

  /** 只渲染清唱：不重跑模型，输出单声道 WAV。 */
  async vocalOnly(req: VocalOnlyRequest): Promise<ConvertDone> {
    return this.run('vocalOnly', {
      vocals: req.vocals, output: req.output,
      vocalGain: req.vocalGain, fadeIn: req.fadeIn, fadeOut: req.fadeOut,
      rmsRatio: req.rmsRatio, mutedRanges: req.mutedRanges ?? [],
    }, REMIX_TIMEOUT_MS);
  }

  /** 只重跑一段时间并拼回 conv；超时按窗口时长给，不按整首给。 */
  async convertRange(req: RangeConvertRequest): Promise<ConvertDone> {
    const span = Math.max(0, req.endSec - req.startSec);
    const timeout = Math.min(
      COVER_TIMEOUT_MS,
      RANGE_BASE_TIMEOUT_MS + Math.ceil(span * RANGE_PER_SECOND_MS),
    );
    return this.run('convertRange', {
      stem: req.stem, conv: req.conv, startSec: req.startSec, endSec: req.endSec,
      contextSec: req.contextSec ?? 0.5, seamSec: req.seamSec ?? 0.3,
      outSr: req.outSr ?? 44100, voice: req.voice ?? '',
      pitch: req.pitch, indexRate: req.indexRate, protect: req.protect,
      inputPeak: req.inputPeak, backupPath: req.backupPath ?? '',
    }, timeout);
  }

  /** 用段落备份还原一段 conv（样本级一致，不跑模型）。 */
  async restoreRange(req: RestoreRangeRequest): Promise<ConvertDone> {
    return this.run('restoreRange', {
      conv: req.conv, backup: req.backup, start: req.start, end: req.end,
    }, RESTORE_TIMEOUT_MS);
  }

  /** 波形包络（min/max），面板拖选用。 */
  async peaks(req: PeaksRequest): Promise<PeaksDone> {
    const done = await this.run('peaks', { path: req.path, buckets: req.buckets ?? 1200 }, PEAKS_TIMEOUT_MS);
    const peaks = done.peaks;
    if (!peaks) throw new RvcError('infer', 'RVC 没有返回波形数据');
    return {
      sampleRate: done.sampleRate,
      frames: peaks.frames,
      durationSec: done.durationSec ?? 0,
      buckets: peaks.buckets,
      min: peaks.min,
      max: peaks.max,
    };
  }

  /** 只读导出音高曲线（CSV），不碰 conv.wav。 */
  async f0(req: F0Request): Promise<F0Done> {
    const done = await this.run('f0', {
      input: req.input, output: req.output, threshold: req.threshold ?? 0.03,
    }, F0_TIMEOUT_MS);
    return {
      ms: done.ms,
      frames: done.frames ?? 0,
      frameRate: done.frameRate ?? 100,
      durationSec: done.durationSec ?? 0,
    };
  }

  /** 母带：响度归一化 + 真峰值限幅，输出另存。 */
  async master(req: MasterRequest): Promise<MasterDone> {
    const done = await this.run('master', {
      input: req.input, output: req.output, format: req.format,
      targetLufs: req.targetLufs, ceilingDb: req.ceilingDb ?? -1,
    }, MASTER_TIMEOUT_MS);
    if (!done.loudness) throw new RvcError('infer', 'RVC 没有返回响度数据');
    return { ...done, loudness: done.loudness };
  }

  private async run(op: 'convert' | 'separate' | 'cover' | 'reconvert' | 'remix' | 'vocalOnly' | 'convertRange' | 'restoreRange' | 'peaks' | 'f0' | 'master', payload: Record<string, unknown>, timeoutMs: number): Promise<ConvertDone> {
    if (!this.ready()) throw new RvcError('unavailable', this.st.detail ?? 'RVC 引擎未就绪');
    const id = ++this.seq;
    const run = () => new Promise<ConvertDone>((resolve, reject) => {
      const child = this.child;
      if (!child?.stdin?.writable) { reject(new RvcError('unavailable', 'RVC worker 已退出')); return; }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RvcError('infer', `RVC 推理超过 ${Math.round(timeoutMs / 1000)} 秒`));
        void this.stop();
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      const line = JSON.stringify({ op, id, ...payload });
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
    const fail = (msg: string): never => {
      this.st = { ...this.st, phase: 'error', detail: msg };
      throw new RvcError('unavailable', msg);
    };
    // spawn 的 ENOENT 也可能只是 cwd 不存在（Node 不区分），先把三个前提逐一说清楚。
    if (!existsSync(python)) fail(`Python 解释器不存在：${python}（在面板点「一键安装」重建依赖）`);
    if (!existsSync(script)) fail(`worker.py 不存在：${script}（重装 RVC 插件）`);
    if (!existsSync(this.opts.codeDir)) fail(`推理代码目录不存在：${this.opts.codeDir}（重装 RVC 插件）`);
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
        RVC_UVR_MODEL: this.opts.uvrModel ?? '',
        // f0 跟踪器：默认 sw2（SwiftF0 打底 + pm 八度守卫），用户无需配置；
        // RVC_F0_METHOD=swift / hy2 / rmvpe / pm 可回退。
        RVC_F0_METHOD: process.env.RVC_F0_METHOD ?? 'sw2',
        // 静音门：默认把「本来没人声」的段压成静音（分离残留/气口不再变成嘶声）；RVC_SILENCE_GATE=0 关闭。
        RVC_SILENCE_GATE: process.env.RVC_SILENCE_GATE ?? (this.opts.silenceGate === false ? '0' : '1'),
        // 气声保护：气声/轻声段换回干声，避免模型「编」出低频嗡鸣；RVC_BREATH_GUARD=0 关闭。
        RVC_BREATH_GUARD: process.env.RVC_BREATH_GUARD ?? (this.opts.breathGuard === false ? '0' : '1'),
        // 高音幻觉保护：输出音高远高于干声的帧换回干声（模型凭空唱高八度）；RVC_HIGH_GUARD=0 关闭。
        RVC_HIGH_GUARD: process.env.RVC_HIGH_GUARD ?? (this.opts.highGuard === false ? '0' : '1'),
        // 高音补救：整段掉八度时降 3 半音重唱、再用 rubberband 保共振峰升回；RVC_HIGH_RESCUE=0 关闭。
        RVC_HIGH_RESCUE: process.env.RVC_HIGH_RESCUE ?? (this.opts.highRescue === false ? '0' : '1'),
        // 前处理提纯：转换前把气声段的谐波强化、噪声压掉；RVC_PRE_PURIFY=0 关闭。
        RVC_PRE_PURIFY: process.env.RVC_PRE_PURIFY ?? (this.opts.prePurify === false ? '0' : '1'),
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
          stages: msg.stages && typeof msg.stages === 'object' ? msg.stages as ConvertDone['stages'] : undefined,
          peakScale: typeof msg.peakScale === 'number' ? msg.peakScale : undefined,
          inputPeak: typeof msg.inputPeak === 'number' ? msg.inputPeak : undefined,
          modelSampleRate: typeof msg.modelSampleRate === 'number' ? msg.modelSampleRate : undefined,
          rmsRatio: typeof msg.rmsRatio === 'number' ? msg.rmsRatio : undefined,
          durationSec: typeof msg.durationSec === 'number' ? msg.durationSec : undefined,
          withBgm: typeof msg.withBgm === 'boolean' ? msg.withBgm : undefined,
          separator: msg.separator === 'mel_band' || msg.separator === 'mdx' ? msg.separator : undefined,
          separatorNote: typeof msg.separatorNote === 'string' && msg.separatorNote ? msg.separatorNote : undefined,
          channels: typeof msg.channels === 'number' ? msg.channels : undefined,
          spliced: msg.spliced && typeof msg.spliced === 'object' ? msg.spliced as ConvertDone['spliced'] : undefined,
          peakFactor: typeof msg.peakFactor === 'number' ? msg.peakFactor : undefined,
          backedUp: msg.backedUp === true,
          restored: msg.restored && typeof msg.restored === 'object' ? msg.restored as ConvertDone['restored'] : undefined,
          peaks: msg.peaks && typeof msg.peaks === 'object' ? msg.peaks as ConvertDone['peaks'] : undefined,
          frames: typeof msg.frames === 'number' ? msg.frames : undefined,
          frameRate: typeof msg.frameRate === 'number' ? msg.frameRate : undefined,
          loudness: msg.loudness && typeof msg.loudness === 'object' ? msg.loudness as LoudnessReport : undefined,
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
