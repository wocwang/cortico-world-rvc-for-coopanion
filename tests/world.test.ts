import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger, WorldHost } from 'cortico/core/types.ts';
import { RVC_DEFAULTS } from '../src/config.ts';
import { RvcWorld } from '../src/world.ts';

const roots: string[] = [];
const worlds: RvcWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.stop();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const log: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, emit: () => {},
  child: () => log,
};

/** 起一个 World：不碰网络、不装任何东西；python 路径故意指向不存在的位置，引擎会立刻报错。 */
async function makeWorld(overrides: Partial<typeof RVC_DEFAULTS> = {}): Promise<{ world: RvcWorld; invoke: (method: string, args?: unknown[]) => Promise<unknown>; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'rvc-world-'));
  roots.push(dataDir);
  const world = new RvcWorld({
    cfg: { ...RVC_DEFAULTS, enabled: true, httpApi: false, voice: '', ...overrides },
    dataDir,
    packageDir: join(dataDir, 'pkg'),
    runtimesRoot: () => join(dataDir, 'runtimes'),
  });
  worlds.push(world);
  await world.start({ log } as unknown as WorldHost);
  const decl = world.webUi('zh');
  return { world, dataDir, invoke: (method, args = []) => decl.invoke!('service', method, args) };
}

/** 造一个「看起来像」的 .pth：zip 头 + 1 MB。 */
function pth(): Buffer {
  const data = Buffer.alloc((1 << 20) + 64, 0x11);
  Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(data, 0);
  return data;
}

interface State {
  phase: string;
  ready: boolean;
  detail: string;
  venv: { phase: string; detail: string | null };
  install: { phase: string; done: number; total: number };
  uvr: { phase: string; done: number; total: number };
  voicesDir: string;
  uvrDir: string;
  voiceCount: number;
  defaultVoice: string;
  uvr5: boolean;
  lastConvert: unknown;
  lastCover: unknown;
  job: { phase: string; error?: string } | null;
}

/** 面板现在把变声/翻唱放后台跑：等 job 进 error，把原因拿回来。 */
async function jobError(invoke: (method: string, args?: unknown[]) => Promise<unknown>, method: string, args: unknown[]): Promise<string> {
  await invoke(method, args);
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
    const s = (await invoke('state')) as State;
    if (s.job?.phase === 'error') return s.job.error ?? '';
    if (s.job?.phase === 'done') return '';
  }
  return '';
}

describe('World 面板数据面', () => {
  it('声明四个面板，配置组交给框架', async () => {
    const { world } = await makeWorld();
    const decl = world.webUi('zh');
    expect(decl.panels?.map((p) => p.id)).toEqual(['service', 'convert', 'cover', 'voices']);
    expect(decl.config?.map((g) => g.id)).toEqual(['world:rvc', 'world:rvc:service']);
    expect(world.webUi('en').panels?.[0]?.title).toBe('Service');
  });

  it('state 覆盖面板要的字段，初始为空目录', async () => {
    const { invoke, dataDir } = await makeWorld();
    const state = (await invoke('state')) as State;
    expect(state.ready).toBe(false);
    expect(state.venv.phase).toBe('absent');
    expect(state.install.phase).toBe('absent');
    expect(state.install.total).toBeGreaterThan(0);
    expect(state.uvr.phase).toBe('absent');
    expect(state.uvr.total).toBeGreaterThan(0);
    expect(state.voicesDir).toBe(join(dataDir, 'voices'));
    expect(state.uvrDir).toBe(join(dataDir, 'uvr5'));
    expect(state.voiceCount).toBe(0);
    expect(state.defaultVoice).toBe('');
    expect(state.uvr5).toBe(false);
    expect(state.lastConvert).toBeNull();
    expect(state.lastCover).toBeNull();
  });

  it('分离模型在位后 uvr5 才变可用', async () => {
    const { invoke, dataDir } = await makeWorld();
    mkdirSync(join(dataDir, 'uvr5'), { recursive: true });
    writeFileSync(join(dataDir, 'uvr5', 'UVR-MDX-NET-Inst_HQ_3.onnx'), Buffer.alloc(1024));
    const state = (await invoke('state')) as State;
    expect(state.uvr5).toBe(true);
  });

  it('导入 .pth 后出现在列表里，并成为默认音色', async () => {
    const { invoke } = await makeWorld();
    const res = (await invoke('import', ['my.pth', pth().toString('base64')])) as { name: string; voices: Array<{ name: string }> };
    expect(res.name).toBe('my.pth');
    expect(res.voices.map((v) => v.name)).toEqual(['my']);
    const state = (await invoke('state')) as State;
    expect(state.voiceCount).toBe(1);
    expect(state.defaultVoice).toBe('my');
  });

  it('导入失败回 error 而不是抛', async () => {
    const { invoke } = await makeWorld();
    const res = (await invoke('import', ['bad.zip', pth().toString('base64')])) as { error?: string };
    expect(res.error).toContain('只接受 .pth 或 .index');
    const tiny = (await invoke('import', ['tiny.pth', Buffer.alloc(16).toString('base64')])) as { error?: string };
    expect(tiny.error).toContain('不像是训练好的权重');
  });

  it('缺少参数或未知方法回 error', async () => {
    const { invoke } = await makeWorld();
    expect(await invoke('import', ['only-name.pth'])).toEqual({ error: '需要文件名与 base64 内容' });
    expect(await invoke('nope')).toEqual({ error: 'unknown method: service.nope' });
  });

  it('引擎不可用时 convert 进后台失败，不落文件', async () => {
    const { invoke, dataDir } = await makeWorld();
    const error = await jobError(invoke, 'convert', ['a.wav', pth().toString('base64'), { format: 'wav' }]);
    expect(error).toMatch(/未就绪|未启动|不存在/);
    expect((await invoke('state') as State).lastConvert).toBeNull();
    expect(dataDir).toBeTruthy();
  });

  it('convert 先过接口同一套参数校验，再问引擎', async () => {
    const { invoke } = await makeWorld();
    expect(await jobError(invoke, 'convert', ['a.txt', pth().toString('base64')])).toContain('不支持的音频扩展名');
    expect(await jobError(invoke, 'convert', ['a.wav'])).toContain('缺少音频内容');
    expect(await jobError(invoke, 'convert', ['a.wav', pth().toString('base64'), { pitch: 99 }])).toContain('pitch 必须是');
    expect(await jobError(invoke, 'convert', ['a.wav', pth().toString('base64'), { separator: 'uvr5' }])).toContain('人声分离模型未安装');
    expect(await jobError(invoke, 'convert', ['a.wav', pth().toString('base64')])).toMatch(/未就绪|未启动|不存在/);
  });

  it('翻唱要等分离模型与引擎都就绪', async () => {
    const { invoke, dataDir } = await makeWorld();
    expect(await jobError(invoke, 'cover', ['song.wav', pth().toString('base64')])).toContain('人声分离模型未安装');
    mkdirSync(join(dataDir, 'uvr5'), { recursive: true });
    writeFileSync(join(dataDir, 'uvr5', 'UVR-MDX-NET-Inst_HQ_3.onnx'), Buffer.alloc(1024));
    expect(await jobError(invoke, 'cover', ['song.wav', pth().toString('base64')])).toMatch(/未就绪|未启动|不存在/);
    expect((await invoke('state') as State).lastCover).toBeNull();
  });

  it('关掉「随软件自动启动」后，挂载完引擎仍是 stopped', async () => {
    const { invoke } = await makeWorld({ autoStart: false });
    const state = (await invoke('state')) as State;
    expect(state.phase).toBe('stopped');
    expect(state.ready).toBe(false);
    // 手动点启动仍会尝试拉起（这里 python 不存在，最终会进 error）。
    await invoke('start');
    let s = (await invoke('state')) as State;
    for (let i = 0; i < 50 && s.phase === 'stopped'; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      s = (await invoke('state')) as State;
    }
    expect(s.phase).not.toBe('stopped');
  });

  it('面板可以手动启停引擎', async () => {
    const { invoke } = await makeWorld();
    const stopped = (await invoke('stop')) as State;
    expect(stopped.phase).toBe('stopped');
    expect(stopped.ready).toBe(false);
    // 这里的 python 路径故意不存在：点启动后必然报错，但状态必须离开 stopped。
    await invoke('start');
    let s = (await invoke('state')) as State;
    for (let i = 0; i < 50 && s.phase === 'stopped'; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      s = (await invoke('state')) as State;
    }
    expect(s.phase).toBe('error');
    expect(s.detail).toContain('Python 解释器不存在');
    // 再点停止：回到 stopped，且之后自动重拉不会把它顶回去（这里只看状态回落）。
    const again = (await invoke('stop')) as State;
    expect(again.phase).toBe('stopped');
  });
});
