import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeInstall, runtimeDir, runtimeReady } from '../src/runtime.ts';

const roots: string[] = [];
const servers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of servers.splice(0)) await close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'rvc-runtime-'));
  roots.push(dir);
  return dir;
};

function crc32(data: Buffer): number {
  let crc = -1;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

/** 造一个「存储」（不压缩）的 zip：能带任意大小的内容，解压后就是一个同名文件。 */
function zipStore(name: string, payload: Buffer): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const crc = crc32(payload);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const localSize = local.length + nameBytes.length + payload.length;
  const centralSize = central.length + nameBytes.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localSize, 16);
  return Buffer.concat([local, nameBytes, payload, central, nameBytes, end]);
}

/** 只放一个空文件的 zip，够跑通下载→校验→解压→落位。 */
const storedZip = (name: string): Buffer => zipStore(name, Buffer.alloc(0));

interface Hit {
  path: string;
  range: string | null;
}

interface ServeOptions {
  /** 服务器假装不认 Range（回 200 + 整段），用来测回退与进度。 */
  ignoreRange?: boolean;
  /** 响应体分块慢慢发，用来在下载途中采样进度。 */
  delayMs?: number;
}

/** 本地 HTTP 服务：按路径回字节，支持 `bytes=start-end` 的 Range。 */
async function serve(files: Record<string, Buffer | '404' | '500'>, opts: ServeOptions = {}): Promise<{ base: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const writeSlow = (res: ServerResponse, body: Buffer): void => {
    if (!opts.delayMs) { res.end(body); return; }
    const step = 16 * 1024;
    let at = 0;
    const tick = (): void => {
      if (at >= body.length) { res.end(); return; }
      res.write(body.subarray(at, at + step));
      at += step;
      setTimeout(tick, opts.delayMs);
    };
    tick();
  };
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    hits.push({ path, range: req.headers.range ?? null });
    const body = files[path];
    if (body === '404' || !body) { res.writeHead(404).end(); return; }
    if (body === '500') { res.writeHead(500).end(); return; }
    const range = opts.ignoreRange ? null : req.headers.range;
    const asked = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;
    if (asked) {
      const start = Number(asked[1]);
      const last = asked[2] ? Number(asked[2]) : body.length - 1;
      if (start >= body.length) { res.writeHead(416).end(); return; }
      const slice = body.subarray(start, Math.min(body.length, last + 1));
      res.writeHead(206, {
        'content-length': slice.length,
        'content-range': `bytes ${start}-${start + slice.length - 1}/${body.length}`,
      });
      writeSlow(res, slice);
      return;
    }
    res.writeHead(200, { 'content-length': body.length });
    writeSlow(res, body);
  };
  const server = createServer(handler);
  servers.push(() => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, hits };
}

/** 一个确定没人听的端口：先占住再关掉。 */
async function closedPort(): Promise<number> {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  await new Promise<void>((done) => { server.close(() => done()); });
  return port;
}

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

describe('RuntimeInstall', () => {
  it('下载、校验、解压后落到 runtime/gpt-sovits/<版本>/<档>', async () => {
    const dir = tempDir();
    const zip = storedZip('runtime/python.exe');
    const { base } = await serve({ '/rt.zip': zip });
    const job = new RuntimeInstall({
      root: dir,
      tier: 'cpu',
      asset: { file: 'rt.zip', bytes: zip.length, sha256: sha(zip), sources: [`${base}/rt.zip`] },
    });
    expect(job.ready()).toBe(false);
    expect(await job.ensure()).toBe(true);
    const target = runtimeDir(dir, 'cpu');
    expect(existsSync(join(target, 'runtime', 'python.exe'))).toBe(true);
    expect(JSON.parse(readFileSync(join(target, 'cortico-runtime.json'), 'utf8')).tier).toBe('cpu');
    expect(job.ready()).toBe(true);
  });

  it('SHA-256 不符时失败，且不落下半成品目录', async () => {
    const dir = tempDir();
    const zip = storedZip('runtime/python.exe');
    const { base } = await serve({ '/rt.zip': zip });
    const job = new RuntimeInstall({
      root: dir,
      tier: 'cpu',
      asset: { file: 'rt.zip', bytes: zip.length, sha256: 'deadbeef', sources: [`${base}/rt.zip`] },
    });
    expect(await job.ensure()).toBe(false);
    expect(job.status().phase).toBe('error');
    expect(runtimeReady(runtimeDir(dir, 'cpu'))).toBe(false);
  });

  it('大文件分片并行下，拼回来的包能解压', async () => {
    const dir = tempDir();
    const zip = zipStore('runtime/python.exe', Buffer.alloc(200_000, 7));
    const { base, hits } = await serve({ '/rt.zip': zip });
    const job = new RuntimeInstall({
      root: dir,
      tier: 'cpu',
      asset: { file: 'rt.zip', bytes: zip.length, sha256: sha(zip), segments: 4, sources: [`${base}/rt.zip`] },
    });
    expect(await job.ensure()).toBe(true);
    const target = runtimeDir(dir, 'cpu');
    expect(statSync(join(target, 'runtime/python.exe')).size).toBe(200_000);
    expect(readdirSync(join(target)).some((n) => n.endsWith('.part'))).toBe(false);
    // 4 片都各自带 `bytes=start-end` 的 Range。
    expect(hits.length).toBeGreaterThanOrEqual(4);
    for (const hit of hits) expect(hit.range).toMatch(/^bytes=\d+-\d+$/);
  });

  it('服务器不认 Range 时退回单连接整段下，不留分片残骸', async () => {
    const dir = tempDir();
    const zip = zipStore('runtime/python.exe', Buffer.alloc(200_000, 7));
    const { base, hits } = await serve({ '/rt.zip': zip }, { ignoreRange: true });
    const job = new RuntimeInstall({
      root: dir,
      tier: 'cpu',
      asset: { file: 'rt.zip', bytes: zip.length, sha256: sha(zip), segments: 4, sources: [`${base}/rt.zip`] },
    });
    expect(await job.ensure()).toBe(true);
    const target = runtimeDir(dir, 'cpu');
    expect(readdirSync(target).filter((n) => n.endsWith('.part'))).toEqual([]);
    expect(hits.some((h) => h.range === null)).toBe(true);
  });

  it('中断留下的归档下次用 Range 续传，不用从头再下', async () => {
    const dir = tempDir();
    const zip = zipStore('runtime/python.exe', Buffer.alloc(64, 1));
    const half = Math.floor(zip.length / 2);
    const { base, hits } = await serve({ '/rt.zip': zip });
    const partial = join(dir, 'gpt-sovits', 'e91506f-1', 'cpu.partial');
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, 'rt.zip'), zip.subarray(0, half));
    const job = new RuntimeInstall({
      root: dir,
      tier: 'cpu',
      asset: { file: 'rt.zip', bytes: zip.length, sha256: sha(zip), sources: [`${base}/rt.zip`] },
    });
    expect(job.status().done).toBe(0);
    expect(await job.ensure()).toBe(true);
    expect(hits[0]!.range).toBe(`bytes=${half}-`);
  });

  it('服务器忽略 Range 时进度不会超过总量', async () => {
    const dir = tempDir();
    const zip = zipStore('runtime/python.exe', Buffer.alloc(1_500_000, 3));
    const half = Math.floor(zip.length / 2);
    const { base } = await serve({ '/rt.zip': zip }, { ignoreRange: true, delayMs: 4 });
    const partial = join(dir, 'gpt-sovits', 'e91506f-1', 'cpu.partial');
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, 'rt.zip'), zip.subarray(0, half));
    const job = new RuntimeInstall({
      root: dir,
      tier: 'cpu',
      asset: { file: 'rt.zip', bytes: zip.length, sha256: sha(zip), sources: [`${base}/rt.zip`] },
    });
    const seen: number[] = [];
    const timer = setInterval(() => seen.push(job.status().done), 10);
    const ok = await job.ensure();
    clearInterval(timer);
    expect(ok).toBe(true);
    // 旧实现把「已有字节」当起点再加整包字节，进度会冲到 150%。
    expect(Math.max(...seen)).toBeLessThanOrEqual(zip.length);
    expect(Math.max(...seen)).toBe(zip.length);
  });

  it('磁盘空间不够时立刻失败，不发请求', async () => {
    const dir = tempDir();
    const zip = storedZip('runtime/python.exe');
    const { base, hits } = await serve({ '/rt.zip': zip });
    const job = new RuntimeInstall({
      root: dir,
      tier: 'cpu',
      asset: { file: 'rt.zip', bytes: 1e15, sha256: 'x', sources: [`${base}/rt.zip`] },
    });
    expect(await job.ensure()).toBe(false);
    expect(job.status().detail).toContain('磁盘空间不足');
    expect(hits).toEqual([]);
  });

  it('失败文案带上真实原因，且不把签名地址原样吐出来', async () => {
    const dir = tempDir();
    const zip = storedZip('runtime/python.exe');
    const port = await closedPort();
    const job = new RuntimeInstall({
      root: dir,
      tier: 'cpu',
      asset: { file: 'rt.zip', bytes: zip.length, sha256: sha(zip), sources: [`http://127.0.0.1:${port}/rt.zip?auth_key=secret`] },
    });
    expect(await job.ensure()).toBe(false);
    const detail = job.status().detail ?? '';
    expect(detail).toContain('共享运行时下载失败');
    expect(detail).toContain('127.0.0.1');
    expect(detail).toMatch(/ECONNREFUSED|ECONNRESET|fetch failed/);
    expect(detail).not.toContain('auth_key');
  });
});
