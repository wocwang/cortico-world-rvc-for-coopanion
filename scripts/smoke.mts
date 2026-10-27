/**
 * 真实链路冒烟：用派生 venv 起 `RvcWorld`（含常驻 worker 与 HTTP 接口），
 * 等 `/health` 就绪后 POST 一段真实 wav 到 `/convert`，把结果写到磁盘。
 *
 * 本机跑（路径可用环境变量覆盖）：
 *   pnpm exec tsx scripts/smoke.mts
 *   RVC_SMOKE_PYTHON=... RVC_SMOKE_CODE=... RVC_SMOKE_VOICES=... RVC_SMOKE_INPUT=... pnpm exec tsx scripts/smoke.mts
 *
 * 需要：gpt-sovits 运行时派生的 venv、RVC 代码目录（含 hubert/rmvpe）、一个音色 `.pth`。
 */
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Logger, WorldHost } from 'cortico/core/types.ts';
import { DEFAULT_PORT, RVC_DEFAULTS } from '../src/config.ts';
import { RvcWorld } from '../src/world.ts';

const temp = tmpdir();
const here = join(temp, 'rvc-t1');
const pythonPath = process.env.RVC_SMOKE_PYTHON || join(temp, 'rvc-probe', 'Scripts', 'python.exe');
const codeDir = process.env.RVC_SMOKE_CODE || join(temp, 'rvc-src');
const input = process.env.RVC_SMOKE_INPUT || join(temp, 'asr-probe', 'in', 'female.wav');
const outDir = join(here, 'out');

/** 音色目录：把 `.pth` 与 `.index` 硬链接到一起，模拟真实的 voices 布局。 */
function prepareVoices(): string {
  const explicit = process.env.RVC_SMOKE_VOICES;
  if (explicit) return explicit;
  const dir = join(here, 'voices');
  mkdirSync(dir, { recursive: true });
  const pairs: Array<[string, string]> = [
    [join(codeDir, 'assets', 'weights', 'daifeiyu.pth'), join(dir, 'daifeiyu.pth')],
    [join(codeDir, 'assets', 'indices', 'daifeiyu.index'), join(dir, 'daifeiyu.index')],
  ];
  for (const [from, to] of pairs) {
    if (!existsSync(from)) continue;
    if (existsSync(to)) rmSync(to, { force: true });
    try { linkSync(from, to); } catch { writeFileSync(to, readFileSync(from)); }
  }
  return dir;
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === 'object' ? done(addr.port) : fail(new Error('拿不到空闲端口'))));
    });
  });
}

const log: Logger = {
  trace: (m) => console.log(`[trace] ${m}`),
  debug: () => {},
  info: (m, d) => console.log(`[info] ${m}`, d ?? ''),
  warn: (m, d) => console.warn(`[warn] ${m}`, d ?? ''),
  error: (m, d) => console.error(`[error] ${m}`, d ?? ''),
  emit: () => {},
  child: () => log,
};

const port = await freePort();
const world = new RvcWorld({
  cfg: {
    ...RVC_DEFAULTS,
    enabled: true,
    codeDir,
    pythonPath,
    voicesDir: prepareVoices(),
    voice: 'daifeiyu',
    httpApi: true,
    httpPort: port || DEFAULT_PORT,
  },
  dataDir: here,
  packageDir: here,
  runtimesRoot: () => '',
});

const host = { log } as unknown as WorldHost;
await world.start(host);

const base = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 180_000;
let health: Record<string, unknown> = {};
while (Date.now() < deadline) {
  health = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
  if (health.ready) break;
  await new Promise((r) => setTimeout(r, 500));
}
console.log('health:', health);
if (!health.ready) {
  const st = (await (world as unknown as { invoke(p: string, m: string): Promise<unknown> }).invoke('service', 'state')) as Record<string, unknown>;
  console.error('未就绪：', st);
  await world.stop();
  process.exit(1);
}

const form = new FormData();
form.set('file', new Blob([readFileSync(input)], { type: 'audio/wav' }), 'female.wav');
form.set('voice', 'daifeiyu');
form.set('pitch', '0');
form.set('indexRate', '0.3');
form.set('protect', '0.33');
form.set('format', 'wav');
form.set('save', '1');
const began = Date.now();
const res = await fetch(`${base}/convert`, { method: 'POST', body: form });
const bytes = Buffer.from(await res.arrayBuffer());
console.log('convert:', res.status, `${Date.now() - began} ms`, 'x-rvc-ms=', res.headers.get('x-rvc-ms'), 'x-rvc-saved=', res.headers.get('x-rvc-saved'));
mkdirSync(outDir, { recursive: true });
const target = join(outDir, 'smoke.wav');
writeFileSync(target, bytes);
console.log('written:', target, statSync(target).size, 'bytes');
if (res.status !== 200 || bytes.subarray(0, 4).toString() !== 'RIFF') {
  console.error('不是 WAV：', bytes.subarray(0, 200).toString('utf8'));
  await world.stop();
  process.exit(1);
}
await world.stop();
console.log('ok');
