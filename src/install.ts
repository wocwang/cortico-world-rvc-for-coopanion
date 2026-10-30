/**
 * 模型资产与示例音色的下载安装。
 *
 * 约定：每个文件下到 `<目标>.partial`，字节数与 SHA-256 都对上才改名到位；
 * 中断留下的 `.partial` 下次用 `Range` 续传（服务器不支持就整段重下）。
 * 每个文件按 `sources` 顺序试，前一个失败（网络、HTTP 状态、校验）才试下一个。
 *
 * 包体不带权重：这里下载的 hubert / rmvpe / 示例音色共约 692 MB，放插件数据目录。
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ASSET_FILES, UVR_FILES, VOICE_FILES, type PinnedFile } from './catalog.ts';

export type InstallPhase = 'absent' | 'working' | 'ready' | 'error';

export interface InstallState {
  phase: InstallPhase;
  /** 已落盘字节（含 `.partial`）。 */
  done: number;
  /** 这一批的总字节。 */
  total: number;
  /** 正在下的文件或失败原因。 */
  detail: string | null;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const sizeOf = (file: string): number => {
  try { return statSync(file).size; } catch { return 0; }
};

/** 文件已在位且大小对（SHA 只在下载完成后校验一次，避免每次启动都哈希几百 MB）。 */
export function hasFile(dir: string, file: PinnedFile): boolean {
  return sizeOf(join(dir, file.path)) === file.bytes;
}

/** 校验失败：数据本身不对，`.partial` 必须扔掉，换下一个来源重下。 */
class VerifyError extends Error {}

/**
 * 把一个地址下到 `dest`；`offset > 0` 时带 `Range` 续传。
 * 服务器忽略 Range（回 200）就截断重下，保证不会把两段数据拼在一起。
 */
async function fetchTo(url: string, dest: string, offset: number, signal: AbortSignal): Promise<void> {
  const headers = offset > 0 ? { Range: `bytes=${offset}-` } : undefined;
  const res = await fetch(url, { signal, redirect: 'follow', headers });
  if (res.status === 416 && offset > 0) return; // 已经下到头，交给调用方校验
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const append = offset > 0 && res.status === 206;
  if (!append && offset > 0) rmSync(dest, { force: true });
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) { done(null, chunk); },
  });
  mkdirSync(dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), counter, createWriteStream(dest, { flags: append ? 'a' : 'w' }), { signal });
}

/** 按来源顺序下完一个文件；网络中断保留 `.partial` 供下次续传，校验失败则丢弃重来。 */
async function downloadFile(dir: string, file: PinnedFile, signal: AbortSignal): Promise<void> {
  const dest = join(dir, file.path);
  const partial = `${dest}.partial`;
  if (hasFile(dir, file)) return;
  mkdirSync(dirname(dest), { recursive: true });
  const errors: string[] = [];
  for (const url of file.sources) {
    if (signal.aborted) throw new Error('已取消');
    let offset = sizeOf(partial);
    if (offset > file.bytes) { rmSync(partial, { force: true }); offset = 0; }
    try {
      await fetchTo(url, partial, offset, signal);
      const size = sizeOf(partial);
      if (size !== file.bytes) throw new VerifyError(`大小 ${size}，应为 ${file.bytes}`);
      if (await sha256File(partial) !== file.sha256) throw new VerifyError('SHA-256 不符');
      renameSync(partial, dest);
      return;
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof VerifyError) rmSync(partial, { force: true });
      errors.push(`${new URL(url).host}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`${file.path} 下载失败：${errors.join('；') || '没有下载来源'}`);
}

/** 一批固定文件（资产或音色）的安装任务；进度按磁盘上的字节实时算。 */
export class FileSetJob {
  private state: { phase: InstallPhase; detail: string | null } = { phase: 'absent', detail: null };
  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;

  constructor(readonly dir: string, readonly files: readonly PinnedFile[]) {}

  /** 还缺的文件（大小对就算有）。 */
  missing(): PinnedFile[] {
    return this.files.filter((f) => !hasFile(this.dir, f));
  }

  bytes(): number {
    return this.files.reduce((n, f) => n + f.bytes, 0);
  }

  status(): InstallState {
    const total = this.bytes();
    if (this.running) return { phase: 'working', done: this.progress(), total, detail: this.state.detail };
    if (!this.missing().length) return { phase: 'ready', done: total, total, detail: null };
    return { phase: this.state.phase === 'error' ? 'error' : 'absent', done: this.progress(), total, detail: this.state.detail };
  }

  install(): Promise<void> {
    if (this.running) return this.running;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.state = { phase: 'working', detail: null };
    this.running = (async () => {
      for (const file of this.missing()) {
        if (signal.aborted) throw new Error('已取消');
        this.state.detail = file.path;
        await downloadFile(this.dir, file, signal);
      }
      this.state = { phase: 'ready', detail: null };
    })()
      .catch((err: unknown) => {
        this.state = {
          phase: 'error',
          detail: signal.aborted ? '已取消' : err instanceof Error ? err.message : String(err),
        };
      })
      .finally(() => {
        this.running = null;
        this.abort = null;
      });
    return this.running;
  }

  cancel(): void {
    this.abort?.abort();
  }

  /** 已落盘字节：完整的算满，未完成的算 `.partial` 大小。 */
  private progress(): number {
    let done = 0;
    for (const file of this.files) {
      if (hasFile(this.dir, file)) { done += file.bytes; continue; }
      done += Math.min(sizeOf(join(this.dir, `${file.path}.partial`)), file.bytes);
    }
    return done;
  }
}

/** 资产（hubert + rmvpe）、示例音色、人声分离模型三个任务，按顺序跑，面板只看这一份汇总状态。 */
export class RvcInstaller {
  readonly assets: FileSetJob;
  readonly voices: FileSetJob;
  readonly uvr: FileSetJob;
  private running: Promise<void> | null = null;

  constructor(assetsDir: string, voicesDir: string, uvrDir: string) {
    this.assets = new FileSetJob(assetsDir, ASSET_FILES);
    this.voices = new FileSetJob(voicesDir, VOICE_FILES);
    this.uvr = new FileSetJob(uvrDir, UVR_FILES);
  }

  state(): InstallState {
    const jobs = [this.assets.status(), this.voices.status(), this.uvr.status()];
    const phase: InstallPhase = jobs.some((j) => j.phase === 'error')
      ? 'error'
      : jobs.some((j) => j.phase === 'working')
        ? 'working'
        : jobs.every((j) => j.phase === 'ready')
          ? 'ready'
          : 'absent';
    return {
      phase,
      done: jobs.reduce((n, j) => n + j.done, 0),
      total: jobs.reduce((n, j) => n + j.total, 0),
      detail: phase === 'error'
        ? (jobs.find((j) => j.phase === 'error')?.detail ?? null)
        : (jobs.find((j) => j.phase === 'working')?.detail ?? null),
    };
  }

  /** 装完资产再装音色、最后分离模型；任一步失败都停下并记在状态里（不抛）。 */
  install(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      await this.assets.install();
      if (this.assets.status().phase === 'ready') await this.voices.install();
      if (this.voices.status().phase === 'ready') await this.uvr.install();
    })().finally(() => { this.running = null; });
    return this.running;
  }

  cancel(): void {
    this.assets.cancel();
    this.voices.cancel();
    this.uvr.cancel();
  }
}
