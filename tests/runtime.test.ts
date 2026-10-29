import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

/** 造一个「存储」zip（不压缩），只放一个空文件，够跑通下载→校验→解压→落位。 */
function storedZip(name: string): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(0, 18);
  local.writeUInt32LE(0, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(0, 20);
  central.writeUInt32LE(0, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const localSize = local.length + nameBytes.length;
  const centralSize = central.length + nameBytes.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localSize, 16);
  return Buffer.concat([local, nameBytes, central, nameBytes, end]);
}

async function serve(files: Record<string, Buffer>): Promise<string> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const body = files[path];
    if (!body) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-length': body.length });
    res.end(body);
  });
  servers.push(() => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

describe('RuntimeInstall', () => {
  it('下载、校验、解压后落到 runtime/gpt-sovits/<版本>/<档>', async () => {
    const dir = tempDir();
    const zip = storedZip('runtime/python.exe');
    const base = await serve({ '/rt.zip': zip });
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
  });

  it('SHA-256 不符时失败，且不落下半成品目录', async () => {
    const dir = tempDir();
    const zip = storedZip('runtime/python.exe');
    const base = await serve({ '/rt.zip': zip });
    const job = new RuntimeInstall({
      root: dir,
      tier: 'cpu',
      asset: { file: 'rt.zip', bytes: zip.length, sha256: 'deadbeef', sources: [`${base}/rt.zip`] },
    });
    expect(await job.ensure()).toBe(false);
    expect(job.status().phase).toBe('error');
    expect(runtimeReady(runtimeDir(dir, 'cpu'))).toBe(false);
  });
});
