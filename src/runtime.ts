/**
 * 共享运行时的按需安装。
 *
 * RVC 的派生 venv 以 `<部署根>/runtimes/gpt-sovits/<版本>/<档>/runtime/python.exe`
 * 为 base（`--system-site-packages`，白拿 torch / torchaudio / ffmpeg / CUDA）。这份运行时本来由
 * gpt-sovits 插件下载；没装它的时候，这里照同一份清单自己下一份，装好的目录布局与它完全一致
 * （含 `cortico-runtime.json`），三个插件共用同一份，谁先装都一样。
 *
 * 下载实测（2026-10-29，国内家宽直连）：魔搭 CDN 单连接被限到约 0.1–0.3 MB/s，6 个连接并行能到 5–6 MB/s，
 * 所以大文件按 64 MB 一片、最多 8 路并行；每片各自断点续传，拼成整包后再校验大小与 SHA-256。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';

export const RUNTIME_ID = 'gpt-sovits';
export const RUNTIME_VERSION = 'e91506f-1';
export const UPSTREAM_COMMIT = 'e91506f1fba265e1841617c3042a1573206a7351';

const MS_OWN = 'https://www.modelscope.cn/models/Phantivia/gpt-sovits-for-coopanion/resolve/master';
const GH_OWN = `https://github.com/Phantivia/cortico-world-gpt-sovits-for-coopanion/releases/download/runtime-${RUNTIME_VERSION}`;
const CUDA_FILE = `gpt-sovits-${RUNTIME_VERSION}-win-x64-cu128.zip`;
const CPU_FILE = `gpt-sovits-${RUNTIME_VERSION}-win-x64-cpu.zip`;

export interface RuntimeAsset {
  file: string;
  bytes: number;
  sha256: string;
  sources: readonly string[];
  /** 解压后大约占多少字节（实测 CPU 档 2.06 GB、显卡档 10.5 GB），磁盘预检用。 */
  extractBytes?: number;
  /** 分片数；不填按 64 MB 一片。测试注入小文件时用，省得造几十 MB 的样例。 */
  segments?: number;
}

/** 显卡档只有魔搭放整包（GitHub 单附件 2 GiB 上限，那边是分片）；CPU 档两处都有。 */
export const RUNTIME_ASSETS: Readonly<Record<'cuda' | 'cpu', RuntimeAsset>> = {
  cuda: {
    file: CUDA_FILE,
    bytes: 4140732064,
    sha256: '87c775a93f9b13195b83bc2901a6176f771e31076bc051acf07a5ccca1db7a78',
    extractBytes: 11300000000,
    sources: [`${MS_OWN}/runtime/${CUDA_FILE}`],
  },
  cpu: {
    file: CPU_FILE,
    bytes: 1036310624,
    sha256: '9ce348074e941388544b4db072ee0b9cfc50c9bd420e61f13ee9364fe90152e1',
    extractBytes: 2210000000,
    sources: [`${MS_OWN}/runtime/${CPU_FILE}`, `${GH_OWN}/${CPU_FILE}`],
  },
};

export type RuntimePhase = 'absent' | 'working' | 'ready' | 'error';

export interface RuntimeState {
  phase: RuntimePhase;
  done: number;
  total: number;
  detail: string | null;
}

export function runtimeDir(root: string, tier: string): string {
  return join(root, RUNTIME_ID, RUNTIME_VERSION, tier);
}

export function runtimeReady(dir: string): boolean {
  return existsSync(join(dir, 'runtime', 'python.exe'));
}

const PROBE_TIMEOUT_MS = 15_000;
/** 一片 64 MB：1 GB 的 CPU 档 16 片，4.1 GB 的显卡档 65 片，慢连接不至于拖死整包。 */
const SEGMENT_BYTES = 64 * 1024 * 1024;
/** 同时在跑的分片数。实测 6 路就能跑满带宽，8 路留点余量。 */
const SEGMENT_PARALLEL = 8;
/** 小于这个就不折腾分片了，单连接直下。 */
const SEGMENT_MIN_BYTES = 32 * 1024 * 1024;
/** 多久没收到一个字节算「连接卡死」。魔搭 CDN 会偶发不动，掐断重连能接着下。 */
const IDLE_TIMEOUT_MS = 45_000;
/** 一个来源最多试几次。 */
const ATTEMPTS = 3;

const sizeOf = (file: string): number => {
  try { return statSync(file).size; } catch { return 0; }
};

/** Windows 10 起自带 bsdtar，能解 zip；PATH 上靠前的 Git tar 不认 zip，所以写全路径。 */
function extract(archive: string, into: string): Promise<void> {
  const tar = process.platform === 'win32' ? resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  return new Promise((done, fail) => {
    const child = spawn(tar, ['-xf', archive, '-C', into], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(`tar 退出码 ${code}：${err.trim().slice(0, 300)}`))));
  });
}

/** 服务器不理 Range（回 200 而不是 206）：分片白搭，退回去单连接整段下。 */
class NoRangeError extends Error {}
/** 校验失败：数据本身不对，必须扔掉重下，不能续传。 */
class VerifyError extends Error {}

/** `fetch failed` 本身没有信息量；把 undici 塞在 cause 里的真正原因（ECONNREFUSED、挂断）带出来。 */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) return `${err.message}（${cause.message}）`;
  if (typeof cause === 'string' && cause) return `${err.message}（${cause}）`;
  return err.message;
}

/**
 * 一个地址下到 `dest`，`existing` 是 `dest` 里已经有的字节数（续传起点）。
 * `range` 给出这次要的绝对区间（分片用）：给了就必须拿到 206，否则抛 `NoRangeError`，
 * 免得把错位的字节拼进分片。每收到一块就重置空闲计时，卡住不动会掐断这次连接。
 */
async function pull(opts: {
  url: string;
  dest: string;
  existing: number;
  range?: { from: number; to: number };
  onBytes: (size: number) => void;
  signal: AbortSignal;
}): Promise<void> {
  const { url, dest, existing, range, onBytes, signal } = opts;
  const header = range ? `bytes=${range.from}-${range.to - 1}` : existing > 0 ? `bytes=${existing}-` : undefined;
  const idle = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), IDLE_TIMEOUT_MS);
  };
  try {
    arm();
    const res = await fetch(url, {
      signal: AbortSignal.any([signal, idle.signal]),
      redirect: 'follow',
      headers: header ? { range: header } : undefined,
    });
    arm();
    if (res.status === 416 && existing > 0) { await res.body?.cancel(); return; }
    if (range && res.status !== 206) {
      await res.body?.cancel();
      throw new NoRangeError('服务器不支持分段下载');
    }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const append = existing > 0 && res.status === 206;
    if (!append && existing > 0) rmSync(dest, { force: true });
    const out = createWriteStream(dest, { flags: append ? 'a' : 'w' });
    let written = append ? existing : 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        const buf = Buffer.from(chunk);
        // 等磁盘落盘（背压）不算「连接空闲」：这段时间掐掉空闲计时，写完再重新起表。
        if (!out.write(buf)) {
          if (timer) { clearTimeout(timer); timer = null; }
          await once(out, 'drain');
        }
        arm();
        written += buf.length;
        onBytes(written);
      }
    } catch (err) {
      out.destroy();
      throw err;
    }
    await new Promise<void>((done, fail) => {
      out.once('error', fail);
      out.end(() => done());
    });
  } catch (err) {
    if (idle.signal.aborted && !signal.aborted) {
      throw new Error(`连接 ${IDLE_TIMEOUT_MS / 1000} 秒没有数据，已断开重试`);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface Segment { file: string; start: number; end: number }

/** 分片计划：每片一个 `<归档>.<i>.part`，片内自带续传位置。 */
function segmentPlan(total: number, archive: string, segments?: number): Segment[] {
  const count = Math.max(1, segments ?? Math.ceil(total / SEGMENT_BYTES));
  const size = Math.ceil(total / count);
  const plan: Segment[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = i * size;
    if (start >= total) break;
    plan.push({ file: `${archive}.${i}.part`, start, end: Math.min(total, start + size) });
  }
  return plan;
}

/** 分片依次拼成归档，拼完一片就删一片（磁盘最多多占一片，不再需要整包副本）。 */
async function joinSegments(archive: string, plan: Segment[]): Promise<void> {
  const out = createWriteStream(archive, { flags: 'w' });
  try {
    for (const part of plan) {
      for await (const chunk of createReadStream(part.file)) {
        if (!out.write(chunk as Buffer)) await once(out, 'drain');
      }
      rmSync(part.file, { force: true });
    }
  } finally {
    await new Promise<void>((done, fail) => {
      out.once('error', fail);
      out.end(() => done());
    });
  }
}

/** 并行下所有分片；全部到位后拼成归档。任一片失败就掐掉其他片，交给上层重试。 */
async function downloadSegments(
  url: string,
  archive: string,
  total: number,
  segments: number | undefined,
  progress: (bytes: number) => void,
  signal: AbortSignal,
  onPhase?: (text: string) => void,
): Promise<void> {
  const plan = segmentPlan(total, archive, segments);
  const got = plan.map((part) => Math.min(sizeOf(part.file), part.end - part.start));
  const report = (): void => progress(got.reduce((a, b) => a + b, 0));
  report();
  const group = new AbortController();
  const merged = AbortSignal.any([signal, group.signal]);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (!merged.aborted) {
      const index = cursor;
      cursor += 1;
      if (index >= plan.length) return;
      const part = plan[index]!;
      if (got[index]! >= part.end - part.start) continue;
      await pull({
        url,
        dest: part.file,
        existing: got[index]!,
        range: { from: part.start + got[index]!, to: part.end },
        onBytes: (size) => { got[index] = size; report(); },
        signal: merged,
      });
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(SEGMENT_PARALLEL, plan.length) }, worker));
  group.abort();
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
  const short = plan.find((part, i) => got[i] !== part.end - part.start);
  if (short) throw new Error(`分片 ${short.file} 没下满（${got[plan.indexOf(short)]}/${short.end - short.start}）`);
  // 分片都齐了：进度已经到了总量，但还要拼成归档才作数；拼接期间告诉面板在做什么。
  onPhase?.('正在拼接归档');
  await joinSegments(archive, plan);
  progress(total);
  clearSegments(archive); // 上次取消留下的、不在本次计划里的旧分片
  onPhase?.('');
}

/** 下载失败/回退到单连接时把手里的分片删掉：不然会混进最终解压目录。 */
function clearSegments(archive: string): void {
  const dir = dirname(archive);
  const prefix = `${basename(archive)}.`;
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(prefix)) rmSync(join(dir, name), { force: true });
    }
  } catch {
    /* 目录不在了就算了 */
  }
}

/** 大文件走分片并行，服务器不支持 Range 就退回单连接整段下。 */
async function downloadAuto(
  url: string,
  archive: string,
  total: number,
  segments: number | undefined,
  progress: (bytes: number) => void,
  signal: AbortSignal,
  onPhase?: (text: string) => void,
): Promise<void> {
  // `segments` 显式给定时（测试）不管文件多小都走分片，好用小样例跑完整流程。
  if (segments !== undefined || total >= SEGMENT_MIN_BYTES) {
    try {
      await downloadSegments(url, archive, total, segments, progress, signal, onPhase);
      return;
    } catch (err) {
      if (signal.aborted || !(err instanceof NoRangeError)) throw err;
      clearSegments(archive);
      progress(0);
    }
  }
  const existing = Math.min(sizeOf(archive), total);
  await pull({ url, dest: archive, existing, onBytes: progress, signal });
}

/** 剩余空间；拿不到就返回 null：宁可继续，也不因为探测失败拦住用户。 */
function freeBytes(dir: string): number | null {
  try {
    const stats = statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/**
 * 下载前看一眼目标盘：要「压缩包 + 解压后目录」一起放得下，不然会下到 100% 才在解压那步失败。
 * 注意目标目录这时还不存在（statfs 会 ENOENT），所以拿已经建好的 `.partial` 探。
 */
function assertFreeSpace(dir: string, asset: RuntimeAsset): void {
  const free = freeBytes(dir);
  if (free === null) return;
  const unpacked = asset.extractBytes ?? asset.bytes * 3;
  const need = Math.ceil(asset.bytes * 1.2) + unpacked + 512 * 1024 * 1024;
  if (free < need) {
    const gb = (n: number): string => (n / 1024 ** 3).toFixed(1);
    throw new Error(
      `磁盘空间不足：这一档下载 ${gb(asset.bytes)} GB、解压后约 ${gb(unpacked)} GB，要预留 ${gb(need)} GB；目标盘只剩 ${gb(free)} GB。可以清一下盘，或在配置里指一个别处的「共享运行时目录」`,
    );
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((done, fail) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', () => done());
    stream.once('error', fail);
  });
  return hash.digest('hex');
}

/** 一件运行时安装任务；`asset` 可注入，测试里用本地小 zip 走完整流程。 */
export class RuntimeInstall {
  private st: RuntimeState = { phase: 'absent', done: 0, total: 0, detail: null };
  private running: Promise<boolean> | null = null;
  private abort: AbortController | null = null;
  private readonly asset: RuntimeAsset;

  constructor(private readonly opts: {
    root: string;
    tier: 'cuda' | 'cpu';
    log?: Logger;
    asset?: RuntimeAsset;
  }) {
    this.asset = opts.asset ?? RUNTIME_ASSETS[opts.tier];
  }

  dir(): string {
    return runtimeDir(this.opts.root, this.opts.tier);
  }

  ready(): boolean {
    return runtimeReady(this.dir());
  }

  status(): RuntimeState {
    if (this.running) return { ...this.st };
    return this.ready()
      ? { phase: 'ready', done: 0, total: this.asset.bytes, detail: null }
      : { ...this.st, phase: this.st.phase === 'error' ? 'error' : 'absent' };
  }

  cancel(): void {
    this.abort?.abort();
  }

  ensure(): Promise<boolean> {
    if (this.running) return this.running;
    if (this.ready()) return Promise.resolve(true);
    this.abort = new AbortController();
    this.st = { phase: 'working', done: 0, total: this.asset.bytes, detail: this.asset.file };
    this.running = this.work(this.abort.signal)
      .then(() => {
        this.st = { phase: 'ready', done: this.asset.bytes, total: this.asset.bytes, detail: null };
        return true;
      })
      .catch((err: unknown) => {
        this.st = {
          ...this.st,
          phase: 'error',
          detail: this.abort?.signal.aborted ? '已取消' : err instanceof Error ? err.message : String(err),
        };
        return false;
      })
      .finally(() => { this.running = null; this.abort = null; });
    return this.running;
  }

  /** 归档与分片已经落在盘上的字节数（不含解压出来的东西）。 */
  private diskBytes(archive: string): number {
    const whole = Math.min(sizeOf(archive), this.asset.bytes);
    if (whole > 0) return whole;
    const plan = segmentPlan(this.asset.bytes, archive, this.asset.segments);
    return plan.reduce((n, part) => n + Math.min(sizeOf(part.file), part.end - part.start), 0);
  }

  private async work(signal: AbortSignal): Promise<void> {
    const dir = this.dir();
    const partial = `${dir}.partial`;
    mkdirSync(partial, { recursive: true });
    const archive = join(partial, this.asset.file);
    // 只留这一档的归档与分片（跨次运行还能续传）；上次解压出来的残骸、别的包都清掉。
    for (const name of readdirSync(partial)) {
      if (name === this.asset.file || name.startsWith(`${this.asset.file}.`)) continue;
      rmSync(join(partial, name), { recursive: true, force: true });
    }
    if (sizeOf(archive) > this.asset.bytes) rmSync(archive, { force: true });
    assertFreeSpace(partial, this.asset);
    const errors: string[] = [];
    let ok = false;
    for (const url of this.asset.sources) {
      for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        try {
          this.st.detail = attempt > 1 ? `${this.asset.file}（第 ${attempt} 次重试）` : this.asset.file;
          this.st.done = this.diskBytes(archive);
          await downloadAuto(url, archive, this.asset.bytes, this.asset.segments, (n) => { this.st.done = n; }, signal, (text) => {
            this.st.detail = text || this.asset.file;
          });
          if (statSync(archive).size !== this.asset.bytes) throw new VerifyError(`大小 ${statSync(archive).size}，应为 ${this.asset.bytes}`);
          if (await sha256File(archive) !== this.asset.sha256) {
            rmSync(archive, { force: true });
            throw new VerifyError('SHA-256 不符');
          }
          ok = true;
          break;
        } catch (err) {
          if (signal.aborted) throw err;
          if (err instanceof VerifyError) rmSync(archive, { force: true });
          errors.push(`${new URL(url).host}${attempt > 1 ? `（第 ${attempt} 次）` : ''}：${describe(err)}`);
        }
      }
      if (ok) break;
    }
    if (!ok) throw new Error(`共享运行时下载失败：${errors.slice(-6).join('；') || '没有下载来源'}`);
    this.st.detail = '正在解压';
    await extract(archive, partial);
    rmSync(archive, { force: true });
    if (!runtimeReady(partial)) {
      throw new Error('压缩包解压后没有 runtime/python.exe，疑似下载或解压不完整；重试仍失败可换「自备运行时」');
    }
    writeFileSync(
      join(partial, 'cortico-runtime.json'),
      JSON.stringify({ id: RUNTIME_ID, version: RUNTIME_VERSION, upstream: UPSTREAM_COMMIT, tier: this.opts.tier }, null, 2),
    );
    this.st.detail = '正在替换运行时目录';
    mkdirSync(join(this.opts.root, RUNTIME_ID, RUNTIME_VERSION), { recursive: true });
    removeDirSafe(dir);
    renameSync(partial, dir);
    this.opts.log?.info('共享运行时已装好', { dir });
  }
}

function removeDirSafe(dir: string): void {
  if (!existsSync(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EBUSY') {
      throw new Error('替换运行时目录失败：文件被占用。先在面板里停掉引擎再重试。');
    }
    throw err;
  }
}

export function probeRuntimePython(dir: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const python = join(dir, 'runtime', 'python.exe');
  if (!existsSync(python)) return Promise.resolve(false);
  return new Promise((done) => {
    const child = spawn(python, ['-I', '-c', 'import sys; print(sys.version_info[:2])'], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); done(false); }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); done(false); });
    child.once('close', (code) => { clearTimeout(timer); done(code === 0); });
  });
}

export function installedTiers(root: string): string[] {
  const base = join(root, RUNTIME_ID, RUNTIME_VERSION);
  if (!existsSync(base)) return [];
  try {
    return readdirSync(base).filter((tier) => runtimeReady(join(base, tier)));
  } catch {
    return [];
  }
}
