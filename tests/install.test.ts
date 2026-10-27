import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PinnedFile } from '../src/catalog.ts';
import { FileSetJob } from '../src/install.ts';

const roots: string[] = [];
const servers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of servers.splice(0)) await close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'rvc-install-'));
  roots.push(dir);
  return dir;
};

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

interface Hit {
  path: string;
  range: string | null;
}

/** 本地 HTTP 服务：按路径回字节，支持 Range；用来测下载、续传与回退。 */
async function serve(files: Record<string, Buffer | '404'>, opts: { ignoreRange?: boolean } = {}): Promise<{ base: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? '/').split('?')[0]!;
    hits.push({ path, range: req.headers.range ?? null });
    const body = files[path];
    if (!body || body === '404') { res.writeHead(404).end(); return; }
    const range = req.headers.range;
    const start = range && !opts.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    if (start >= body.length) { res.writeHead(416).end(); return; }
    if (start > 0) {
      res.writeHead(206, { 'content-length': body.length - start, 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` });
      res.end(body.subarray(start));
      return;
    }
    res.writeHead(200, { 'content-length': body.length });
    res.end(body);
  };
  const server = createServer(handler);
  servers.push(() => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return { base: `http://127.0.0.1:${port}`, hits };
}

const pinned = (sources: string[], data: Buffer, path = 'blob.bin'): PinnedFile => ({
  path, bytes: data.length, sha256: sha(data), sources,
});

describe('文件下载安装', () => {
  it('下完、大小与 SHA-256 都对才落位', async () => {
    const data = Buffer.from('hello rvc assets');
    const { base, hits } = await serve({ '/blob.bin': data });
    const dir = tempDir();
    const job = new FileSetJob(dir, [pinned([`${base}/blob.bin`], data)]);
    expect(job.status().phase).toBe('absent');
    await job.install();
    expect(job.status()).toMatchObject({ phase: 'ready', done: data.length, total: data.length });
    expect(readFileSync(join(dir, 'blob.bin')).equals(data)).toBe(true);
    expect(existsSync(join(dir, 'blob.bin.partial'))).toBe(false);
    expect(hits[0]!.range).toBeNull();
  });

  it('中断留下的 .partial 用 Range 续传', async () => {
    const data = Buffer.from('0123456789abcdef'.repeat(8));
    const half = Math.floor(data.length / 2);
    const { base, hits } = await serve({ '/blob.bin': data });
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'blob.bin.partial'), data.subarray(0, half));
    const job = new FileSetJob(dir, [pinned([`${base}/blob.bin`], data)]);
    expect(job.status().done).toBe(half);
    await job.install();
    expect(hits[0]!.range).toBe(`bytes=${half}-`);
    expect(readFileSync(join(dir, 'blob.bin')).equals(data)).toBe(true);
  });

  it('服务器忽略 Range 时整段重下，不拼坏文件', async () => {
    const data = Buffer.from('abcdefghijklmnop');
    const { base } = await serve({ '/blob.bin': data }, { ignoreRange: true });
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'blob.bin.partial'), Buffer.from('XXXXXXXX'));
    const job = new FileSetJob(dir, [pinned([`${base}/blob.bin`], data)]);
    await job.install();
    expect(readFileSync(join(dir, 'blob.bin')).equals(data)).toBe(true);
  });

  it('校验失败丢掉坏数据，换下一个来源', async () => {
    const data = Buffer.from('the real payload');
    const bad = Buffer.from('the fake payload');
    const { base, hits } = await serve({ '/bad.bin': bad, '/good.bin': data });
    const dir = tempDir();
    const job = new FileSetJob(dir, [pinned([`${base}/bad.bin`, `${base}/good.bin`], data)]);
    await job.install();
    expect(job.status().phase).toBe('ready');
    expect(readFileSync(join(dir, 'blob.bin')).equals(data)).toBe(true);
    expect(hits.map((h) => h.path)).toEqual(['/bad.bin', '/good.bin']);
  });

  it('前一个来源 404 或截断时自动回退', async () => {
    const data = Buffer.from('payload that comes back');
    const { base } = await serve({ '/missing.bin': '404', '/cut.bin': data.subarray(0, 5), '/good.bin': data });
    const dir = tempDir();
    const job = new FileSetJob(dir, [pinned([`${base}/missing.bin`, `${base}/cut.bin`, `${base}/good.bin`], data)]);
    await job.install();
    expect(job.status().phase).toBe('ready');
    expect(readFileSync(join(dir, 'blob.bin')).equals(data)).toBe(true);
  });

  it('已完整的文件不再下载', async () => {
    const data = Buffer.from('cached');
    const { base, hits } = await serve({ '/blob.bin': data });
    const dir = tempDir();
    writeFileSync(join(dir, 'blob.bin'), data);
    const job = new FileSetJob(dir, [pinned([`${base}/blob.bin`], data)]);
    expect(job.status()).toMatchObject({ phase: 'ready', done: data.length, total: data.length });
    await job.install();
    expect(hits).toEqual([]);
  });

  it('全部来源失败时进 error，保留能续传的 .partial', async () => {
    const data = Buffer.from('never arrives');
    const { base } = await serve({ '/blob.bin': '404' });
    const dir = tempDir();
    writeFileSync(join(dir, 'blob.bin.partial'), data.subarray(0, 4));
    const job = new FileSetJob(dir, [pinned([`${base}/blob.bin`], data)]);
    await job.install();
    expect(job.status().phase).toBe('error');
    expect(job.status().detail).toContain('download.bin 下载失败'.replace('download.bin', 'blob.bin'));
    expect(statSync(join(dir, 'blob.bin.partial')).size).toBe(4);
  });
});
