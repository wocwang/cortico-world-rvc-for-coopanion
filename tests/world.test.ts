import { mkdtempSync, rmSync } from 'node:fs';
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
async function makeWorld(): Promise<{ world: RvcWorld; invoke: (method: string, args?: unknown[]) => Promise<unknown>; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'rvc-world-'));
  roots.push(dataDir);
  const world = new RvcWorld({
    cfg: { ...RVC_DEFAULTS, enabled: true, httpApi: false, voice: '' },
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
  venv: { phase: string; detail: string | null };
  install: { phase: string; done: number; total: number };
  voicesDir: string;
  voiceCount: number;
  defaultVoice: string;
  uvr5: boolean;
  lastConvert: unknown;
}

describe('World 面板数据面', () => {
  it('声明三个面板，配置组交给框架', async () => {
    const { world } = await makeWorld();
    const decl = world.webUi('zh');
    expect(decl.panels?.map((p) => p.id)).toEqual(['service', 'convert', 'voices']);
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
    expect(state.voicesDir).toBe(join(dataDir, 'voices'));
    expect(state.voiceCount).toBe(0);
    expect(state.defaultVoice).toBe('');
    expect(state.uvr5).toBe(false);
    expect(state.lastConvert).toBeNull();
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

  it('引擎不可用时 convert 直接失败，不落文件', async () => {
    const { invoke, dataDir } = await makeWorld();
    await expect(invoke('convert', ['a.wav', pth().toString('base64'), { format: 'wav' }])).rejects.toThrow(/未就绪|未启动/);
    expect((await invoke('state') as State).lastConvert).toBeNull();
    expect(dataDir).toBeTruthy();
  });

  it('convert 先过接口同一套参数校验，再问引擎', async () => {
    const { invoke } = await makeWorld();
    await expect(invoke('convert', ['a.txt', pth().toString('base64')])).rejects.toThrow('不支持的音频扩展名');
    await expect(invoke('convert', ['a.wav'])).rejects.toThrow('缺少音频内容');
    await expect(invoke('convert', ['a.wav', pth().toString('base64'), { pitch: 99 }])).rejects.toThrow('pitch 必须是');
    await expect(invoke('convert', ['a.wav', pth().toString('base64'), { separator: 'uvr5' }])).rejects.toThrow('tools/uvr5');
    await expect(invoke('convert', ['a.wav', pth().toString('base64')])).rejects.toThrow(/未就绪|未启动/);
  });
});
