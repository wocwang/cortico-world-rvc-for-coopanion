/**
 * 共享运行时的按需安装。
 *
 * RVC 的派生 venv 以 `<部署根>/runtimes/gpt-sovits/<版本>/<档>/runtime/python.exe`
 * 为 base（`--system-site-packages`，白拿 torch / torchaudio / ffmpeg / CUDA）。这份运行时本来由
 * gpt-sovits 插件下载；没装它的时候，这里照同一份清单自己下一份，装好的目录布局与它完全一致
 * （含 `cortico-runtime.json`），三个插件共用同一份，谁先装都一样。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
}

/** 显卡档只有魔搭放整包（GitHub 单附件 2 GiB 上限，那边是分片）；CPU 档两处都有。 */
export const RUNTIME_ASSETS: Readonly<Record<'cuda' | 'cpu', RuntimeAsset>> = {
  cuda: {
    file: CUDA_FILE,
    bytes: 4140732064,
    sha256: '87c775a93f9b13195b83bc2901a6176f771e31076bc051acf07a5ccca1db7a78',
    sources: [`${MS_OWN}/runtime/${CUDA_FILE}`],
  },
  cpu: {
    file: CPU_FILE,
    bytes: 1036310624,
    sha256: '9ce348074e941388544b4db072ee0b9cfc50c9bd420e61f13ee9364fe90152e1',
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

/** 下载一个文件；`resume` 时从已有字节接着下（魔搭签名地址会过期，重试拿到的是新签名）。 */
async function download(url: string, dest: string, progress: (bytes: number) => void, signal: AbortSignal, resume = false): Promise<void> {
  const existing = resume && existsSync(dest) ? statSync(dest).size : 0;
  const res = await fetch(url, {
    signal,
    redirect: 'follow',
    headers: existing > 0 ? { range: `bytes=${existing}-` } : undefined,
  });
  if (!res.ok || !res.body) {
    if (res.status === 416 && existing > 0) return;
    throw new Error(`HTTP ${res.status}`);
  }
  const append = existing > 0 && res.status === 206;
  if (!append && existing > 0) rmSync(dest, { force: true });
  const out = createWriteStream(dest, { flags: append ? 'a' : 'w' });
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      const buf = Buffer.from(chunk);
      progress(buf.length);
      if (!out.write(buf)) await new Promise<void>((done) => out.once('drain', done));
    }
  } catch (err) {
    out.destroy();
    throw err;
  }
  await new Promise<void>((done, fail) => { out.end(() => done()); out.once('error', fail); });
}

/** 下载前看一眼目标盘剩余空间：要「下载 + 解压」双份余量，不然会下到 100% 才在解压那步失败。 */
function assertFreeSpace(dir: string, needBytes: number): void {
  try {
    const stats = statfsSync(dir);
    const free = Number(stats.bavail) * Number(stats.bsize);
    const need = Math.ceil(needBytes * 2.2) + 512 * 1024 * 1024;
    if (free < need) {
      const gb = (n: number): string => (n / 1024 ** 3).toFixed(1);
      throw new Error(`磁盘空间不足：还要约 ${gb(need)} GB（下载 + 解压），目标盘只剩 ${gb(free)} GB`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('磁盘空间不足')) throw err;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
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

  private async work(signal: AbortSignal): Promise<void> {
    const dir = this.dir();
    const partial = `${dir}.partial`;
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    const archive = join(partial, this.asset.file);
    assertFreeSpace(dir, this.asset.bytes);
    const errors: string[] = [];
    let ok = false;
    for (const url of this.asset.sources) {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          // 续传：断点前已下的字节继续用，重试会重新拿一次签名地址。
          this.st.done = existsSync(archive) ? statSync(archive).size : 0;
          await download(url, archive, (n) => { this.st.done += n; }, signal, true);
          if (statSync(archive).size !== this.asset.bytes) throw new Error(`大小 ${statSync(archive).size}，应为 ${this.asset.bytes}`);
          if (await sha256File(archive) !== this.asset.sha256) {
            rmSync(archive, { force: true });
            throw new Error('SHA-256 不符');
          }
          ok = true;
          break;
        } catch (err) {
          if (signal.aborted) throw err;
          errors.push(`${url}${attempt > 1 ? `（第 ${attempt} 次）` : ''}：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (ok) break;
    }
    if (!ok) throw new Error(errors.slice(-6).join('\n') || '没有下载来源');
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
