/**
 * 派生 venv：以 gpt-sovits 运行时为 base（`--system-site-packages`）建一个私有 venv，
 * 只补 RVC 推理缺的两个包，**不复制、也不修改**共享运行时。
 *
 * 面板的「一键安装」会先跑这里：依赖就绪后再下载权重，最后自动拉起引擎。
 * 已经能 `import faiss, parselmouth` 就不动它，所以重复点安装是安全的。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';

export type VenvPhase = 'absent' | 'working' | 'ready' | 'error';

export interface VenvState {
  phase: VenvPhase;
  /** 正在做哪一步，或失败原因。 */
  detail: string | null;
}

/** T0 探针里验证过的两个包与版本；运行时自带的 torch/transformers 不再装。 */
export const VENV_PACKAGES = ['faiss-cpu==1.15.1', 'praat-parselmouth==0.4.7'];
/**
 * 依赖先走阿里云镜像（国内直连 PyPI 经常 SSL 中断；清华源对 pip 的 UA 返回 403，不能用），
 * 镜像失败再回官方 PyPI。网络参数收紧，免得默认重试把「安装中」卡住。
 */
const PIP_MIRROR = 'https://mirrors.aliyun.com/pypi/simple/';
const PIP_OFFICIAL = 'https://pypi.org/simple';
const PIP_NET_ARGS = ['--timeout', '30', '--retries', '2'];
/** 失败时保留的日志行数。 */
const TAIL_LINES = 12;
const PROBE_TIMEOUT_MS = 90_000;
const PIP_TIMEOUT_MS = 600_000;

export interface RvcVenvOptions {
  /** 派生 venv 的 python.exe。 */
  pythonPath: string;
  /** base 运行时的 python.exe；派生 venv 从它长出来。 */
  basePython: string;
  /** 显卡档：额外装 onnxruntime-gpu，让分离也走显卡（装不上就继续 CPU）。 */
  gpu?: boolean;
  log?: Logger;
}

export class RvcVenv {
  private st: VenvState = { phase: 'absent', detail: null };
  private running: Promise<void> | null = null;
  private child: ChildProcess | null = null;
  private tail: string[] = [];

  constructor(private readonly opts: RvcVenvOptions) {}

  state(): VenvState {
    return { ...this.st };
  }

  /** 只探一次：venv 已经能 import 就标就绪，不用等用户点安装。 */
  async check(): Promise<VenvState> {
    if (this.running || this.st.phase === 'ready') return this.state();
    // 推理档换了：旧 venv 的 base 是另一档运行时，先别探测，等面板「一键安装」重建。
    if (!this.baseMatches()) {
      this.st = { phase: 'absent', detail: '推理档变了，需要重建派生 venv' };
      return this.state();
    }
    if (await this.probe()) this.st = { phase: 'ready', detail: null };
    return this.state();
  }

  /** 检查 + 创建 + 补包；不抛，结果看 `state()`。 */
  ensure(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  cancel(): void {
    this.kill();
    if (this.st.phase === 'working') this.st = { phase: 'absent', detail: '已取消' };
  }

  /** 面板卸载掉派生 venv 后调用：清掉缓存状态，下次安装会重建。 */
  reset(): void {
    this.st = { phase: 'absent', detail: null };
  }

  private async run(): Promise<void> {
    this.tail = [];
    this.st = { phase: 'working', detail: '检查依赖' };
    if (!this.baseMatches()) {
      this.st = { phase: 'working', detail: '推理档变了，重建派生 venv' };
      try {
        rmSync(this.venvRoot(), { recursive: true, force: true });
      } catch (err) {
        this.st = { phase: 'error', detail: `删除旧 venv 失败：${err instanceof Error ? err.message : String(err)}` };
        return;
      }
    }
    if (await this.probe()) {
      if (this.opts.gpu) await this.installGpuOrt();
      this.st = { phase: 'ready', detail: null };
      return;
    }
    const { pythonPath, basePython } = this.opts;
    // 没有 base 就长不出 venv：面板的「一键安装」会先下一份共享运行时，这里只说清还差什么。
    if (!existsSync(basePython) && !existsSync(pythonPath)) {
      this.st = { phase: 'error', detail: `还没有共享运行时（${basePython || '未填运行时目录'}）：点面板「安装」，会先下载运行时（CPU 约 1 GB / 显卡约 4 GB），或在配置里填「运行时目录」` };
      return;
    }
    if (!existsSync(pythonPath)) {
      this.st = { phase: 'working', detail: '创建派生 venv' };
      const code = await this.exec(basePython, ['-m', 'venv', '--system-site-packages', this.venvRoot()], PIP_TIMEOUT_MS);
      if (code !== 0) { this.st = { phase: 'error', detail: `创建 venv 失败：${this.lastLine()}` }; return; }
    }
    this.st = { phase: 'working', detail: '安装 faiss / parselmouth' };
    const base = ['-I', '-X', 'utf8', '-u', '-m', 'pip', 'install', '--no-warn-script-location', ...PIP_NET_ARGS, ...VENV_PACKAGES];
    let code = await this.exec(pythonPath, [...base, '-i', PIP_MIRROR], PIP_TIMEOUT_MS);
    if (code !== 0) {
      this.st = { phase: 'working', detail: '镜像没装上，换官方 PyPI 重试' };
      this.opts.log?.warn('RVC 依赖镜像失败，改走官方 PyPI', { tail: this.tail.slice(-3) });
      code = await this.exec(pythonPath, [...base, '-i', PIP_OFFICIAL], PIP_TIMEOUT_MS);
    }
    if (code !== 0) { this.st = { phase: 'error', detail: `装依赖失败：${this.lastLine()}` }; return; }
    if (this.opts.gpu) await this.installGpuOrt();
    if (await this.probe()) this.st = { phase: 'ready', detail: null };
    else this.st = { phase: 'error', detail: `依赖装完了但 import 不过：${this.lastLine()}` };
  }

  /**
   * 显卡档补一份 onnxruntime-gpu，人声分离也走显卡。装不上只警告、不影响 CPU 出活，
   * 所以版本钉死、失败不回滚，面板仍是 ready。
   */
  private async installGpuOrt(): Promise<void> {
    this.st = { phase: 'working', detail: '安装显卡分离（onnxruntime-gpu）' };
    const base = ['-I', '-X', 'utf8', '-u', '-m', 'pip', 'install', '--no-warn-script-location', ...PIP_NET_ARGS, 'onnxruntime-gpu==1.22.0'];
    let code = await this.exec(this.opts.pythonPath, [...base, '-i', PIP_MIRROR], PIP_TIMEOUT_MS);
    if (code !== 0) {
      this.opts.log?.warn('onnxruntime-gpu 镜像失败，改走官方 PyPI', { tail: this.tail.slice(-3) });
      code = await this.exec(this.opts.pythonPath, [...base, '-i', PIP_OFFICIAL], PIP_TIMEOUT_MS);
    }
    if (code !== 0) this.opts.log?.warn('onnxruntime-gpu 没装上，分离继续用 CPU', { tail: this.tail.slice(-3) });
  }

  /** venv 根：`<root>/Scripts/python.exe` 往上两级。 */
  private venvRoot(): string {
    return dirname(dirname(this.opts.pythonPath));
  }

  /**
   * 派生 venv 是否仍以当前 base 运行时为底：读 `pyvenv.cfg` 的 `home`。
   * 没有 base、没有 venv 或读不到 cfg 时按匹配处理（不擅自删用户目录）。
   */
  private baseMatches(): boolean {
    if (!this.opts.basePython) return true;
    try {
      const cfg = readFileSync(join(this.venvRoot(), 'pyvenv.cfg'), 'utf8');
      const home = /^\s*home\s*=\s*(.+)$/mi.exec(cfg)?.[1]?.trim();
      if (!home) return true;
      return resolve(home) === resolve(dirname(this.opts.basePython));
    } catch {
      return true;
    }
  }

  private async probe(): Promise<boolean> {
    if (!existsSync(this.opts.pythonPath)) return false;
    const code = await this.exec(this.opts.pythonPath, ['-I', '-c', 'import faiss, parselmouth'], PROBE_TIMEOUT_MS, false);
    return code === 0;
  }

  /**
   * 跑一条命令并等退出码；超时或取消返回 -1。`capture` 为 false 时不记日志（探针用）。
   */
  private exec(file: string, args: string[], timeoutMs: number, capture = true): Promise<number> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        if (capture) this.push(err instanceof Error ? err.message : String(err));
        resolve(-1);
        return;
      }
      this.child = child;
      if (capture) {
        child.stdout?.on('data', (chunk: Buffer) => this.pushChunk(chunk));
        child.stderr?.on('data', (chunk: Buffer) => this.pushChunk(chunk));
      }
      const timer = setTimeout(() => { this.kill(); resolve(-1); }, timeoutMs);
      timer.unref();
      child.once('error', (err) => {
        clearTimeout(timer);
        this.child = null;
        if (capture) this.push(err.message);
        resolve(-1);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (this.child === child) this.child = null;
        resolve(code ?? -1);
      });
    });
  }

  private kill(): void {
    const child = this.child;
    this.child = null;
    if (!child?.pid || child.exitCode !== null) return;
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGTERM');
  }

  private pushChunk(chunk: Buffer): void {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim()) this.push(line.trim());
    }
  }

  private push(line: string): void {
    this.tail.push(line.slice(0, 240));
    if (this.tail.length > TAIL_LINES) this.tail.shift();
  }

  /** 最后一行有内容就带上，否则给一句通用说明。 */
  private lastLine(): string {
    return this.tail.slice(-2).join(' | ') || '没有输出';
  }
}
