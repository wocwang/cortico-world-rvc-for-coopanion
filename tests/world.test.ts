import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger, WorldHost } from 'cortico/core/types.ts';
import { RVC_DEFAULTS, configGroups } from '../src/config.ts';
import { createSession, readSession, writeSession, type RefineSession } from '../src/session.ts';
import { RvcWorld, isMemoryError } from '../src/world.ts';

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

  it('能统计占用、卸载自己的模型；共享运行时拒绝卸载', async () => {
    const { invoke, dataDir } = await makeWorld();
    mkdirSync(join(dataDir, 'uvr5'), { recursive: true });
    writeFileSync(join(dataDir, 'uvr5', 'UVR-MDX-NET-Inst_HQ_3.onnx'), Buffer.alloc(4096));
    mkdirSync(join(dataDir, 'assets'), { recursive: true });
    writeFileSync(join(dataDir, 'assets', 'hubert.pt'), Buffer.alloc(2048));
    const store = (await invoke('storage')) as { items: Array<{ id: string; bytes: number; shared: boolean }> };
    expect(store.items.find((i) => i.id === 'uvr5')?.bytes).toBeGreaterThan(0);
    expect(store.items.find((i) => i.id === 'assets')?.bytes).toBeGreaterThan(0);
    expect(store.items.find((i) => i.id === 'runtime')?.shared).toBe(true);
    await expect(invoke('uninstall', ['runtime'])).rejects.toThrow('共用');
    await invoke('uninstall', ['uvr5']);
    expect((await invoke('state') as State).uvr5).toBe(false);
    const after = (await invoke('storage')) as { items: Array<{ id: string; bytes: number }> };
    expect(after.items.find((i) => i.id === 'uvr5')?.bytes).toBe(0);
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

  it('原地重新翻唱先查会话与分轨，不需要重新上传原声', async () => {
    const { invoke, dataDir } = await makeWorld();
    expect(await jobError(invoke, 'coverRerun', ['nope'])).toContain('找不到会话');

    const empty = seedSession(dataDir);
    expect(await jobError(invoke, 'coverRerun', [empty.id])).toContain('会话缺少 stems/vocals.wav');

    const half = seedSession(dataDir, { stems: true });
    expect(await jobError(invoke, 'coverRerun', [half.id])).toContain('会话缺少 stems/inst.wav');
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

/** 造一个会话：默认是 P1 时代的老清单（没有 masters 字段），可按需登记成品与分轨。 */
function seedSession(
  dataDir: string,
  opts: {
    outputs?: string[];
    stems?: boolean;
    masters?: Array<{ path: string; at?: string; targetLufs?: number }>;
  } = {},
): { id: string; dir: string } {
  const { id, dir } = createSession(dataDir);
  const at = new Date().toISOString();
  const rec: RefineSession = {
    version: 1,
    id,
    createdAt: at,
    updatedAt: at,
    engine: { kind: 'rvc', voice: 'daifeiyu', modelSampleRate: 40000 },
    source: { durationSec: 12.5, inputPeak: 0.8, format: 'wav' },
    stems: { vocals: 'stems/vocals.wav', inst: 'stems/inst.wav' },
    converted: {
      path: 'vocals/conv.wav',
      sampleRate: 44100,
      channels: 1,
      defaults: { pitch: 0, indexRate: 0.3, protect: 0.33, chunk: true },
    },
    segments: [],
    mix: { vocalGainDb: 0, instGainDb: 0, rmsRatio: 1, rmsFrozen: true, fadeInSec: 0, fadeOutSec: 0, peakScale: 1 },
    outputs: (opts.outputs ?? []).map((path) => ({
      format: path.endsWith('.mp3') ? 'mp3' as const : 'wav' as const,
      path,
      at,
    })),
  };
  if (opts.masters) {
    rec.masters = opts.masters.map((item) => ({
      format: item.path.endsWith('.mp3') ? 'mp3' as const : 'wav' as const,
      path: item.path,
      at: item.at ?? at,
      targetLufs: item.targetLufs ?? -14,
      ceilingDb: -1,
      inputLufs: -18,
      inputTruePeakDb: -3,
      outputLufs: item.targetLufs ?? -14,
      outputTruePeakDb: -2,
      gainDb: 4,
      limitedDb: 0,
    }));
  }
  writeSession(dataDir, id, rec);
  if (opts.stems) writeFileSync(join(dir, 'stems', 'vocals.wav'), Buffer.alloc(1024));
  for (const path of opts.outputs ?? []) writeFileSync(join(dir, path), Buffer.alloc(2048, 0x33));
  for (const item of opts.masters ?? []) writeFileSync(join(dir, item.path), Buffer.alloc(3072, 0x55));
  return { id, dir };
}

describe('母带 / 音高 / A/B 的数据面', () => {
  it('母带只认三档预设，必须有已登记且还在的成品', async () => {
    const { invoke, dataDir } = await makeWorld();
    const empty = seedSession(dataDir);
    expect(await jobError(invoke, 'master', [empty.id, { targetLufs: -12 }])).toContain('母带只支持 -14 / -16 / -23 LUFS 三档');
    expect(await jobError(invoke, 'master', [empty.id, { targetLufs: -14 }])).toContain('这个会话还没有成品');

    const missing = seedSession(dataDir, { outputs: ['out/mix-1.wav'] });
    const rec = readSession(dataDir, missing.id)!;
    rec.outputs[0]!.path = 'out/gone.wav';
    writeSession(dataDir, missing.id, rec);
    expect(await jobError(invoke, 'master', [missing.id, { targetLufs: -16 }])).toContain('最近一次成品文件不在了');
    expect(await jobError(invoke, 'master', ['', { targetLufs: -14 }])).toContain('找不到会话');
  });

  it('A/B 只取会话里登记的成品，返回 $file 而不是塞 base64', async () => {
    const { invoke, dataDir } = await makeWorld();
    const { id } = seedSession(dataDir, { outputs: ['out/mix-1.wav', 'out/mix-2.mp3'] });
    const first = (await invoke('refineAudio', [id, 0])) as { $file?: { mime: string; bytes: number; sha256: string } };
    expect(first.$file?.mime).toBe('audio/wav');
    expect(first.$file?.bytes).toBe(2048);
    expect(first.$file?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const second = (await invoke('refineAudio', [id, 1])) as { $file?: { mime: string } };
    expect(second.$file?.mime).toBe('audio/mpeg');
    await expect(invoke('refineAudio', [id, 2])).rejects.toThrow('成品序号无效');
    await expect(invoke('refineAudio', [id, -1])).rejects.toThrow('成品序号无效');
    await expect(invoke('refineAudio', ['nope', 0])).rejects.toThrow('找不到会话');
  });

  it('成品清单把混音与母带按时间排在一起，可取指定母带试听/另存', async () => {
    const { invoke, dataDir } = await makeWorld();
    const { id } = seedSession(dataDir, {
      outputs: ['out/mix-1.wav'],
      masters: [{ path: 'out/master-1.wav', at: '2099-01-01T00:00:00.000Z', targetLufs: -16 }],
    });
    const state = (await invoke('refineState', [id])) as {
      files?: Array<{ kind: string; index: number; format: string; path: string; bytes: number }>;
    };
    expect(state.files?.map((f) => [f.kind, f.index, f.path, f.bytes])).toEqual([
      ['output', 0, 'out/mix-1.wav', 2048],
      ['master', 0, 'out/master-1.wav', 3072],
    ]);

    const master = (await invoke('refineAudio', [id, 0, 'master'])) as {
      $file?: { mime: string; bytes: number };
    };
    expect(master.$file?.mime).toBe('audio/wav');
    expect(master.$file?.bytes).toBe(3072);
    await expect(invoke('refineAudio', [id, 1, 'master'])).rejects.toThrow('成品序号无效');

    const saved = (await invoke('sessionFile', [id, 'master', 0])) as { ext: string; bytes: number };
    expect(saved.ext).toBe('.wav');
    expect(saved.bytes).toBe(3072);
    const first = (await invoke('sessionFile', [id, 'output', 0])) as { bytes: number };
    expect(first.bytes).toBe(2048);
    await expect(invoke('sessionFile', [id, 'master', 1])).rejects.toThrow('还没有母带');
  });

  it('音高体检缺人声分轨时报错；没有 masters 的老会话照常打开', async () => {
    const { invoke, dataDir } = await makeWorld();
    const old = seedSession(dataDir);
    await expect(invoke('refinePitch', [old.id])).rejects.toThrow('缺少人声分轨');
    await expect(invoke('refinePitch', [''])).rejects.toThrow('找不到会话');

    const state = (await invoke('refineState', [old.id])) as { session: RefineSession | null };
    expect(state.session?.id).toBe(old.id);
    expect(state.session?.masters).toBeUndefined();
    // 打开时补出 20 秒段落网格，但不会凭空写 masters。
    expect(state.session?.segments.length).toBe(1);
    expect(readSession(dataDir, old.id)?.masters).toBeUndefined();
  });
});

describe('内存不足识别', () => {
  it('认得 numpy / torch 的内存分配失败，普通报错不算', () => {
    expect(isMemoryError(
      '【单次推理】状态：失败\nnumpy.core._exceptions._ArrayMemoryError: Unable to allocate 30.8 MiB for an array with shape (1314, 8, 768) and data type float32',
    )).toBe(true);
    expect(isMemoryError('torch.OutOfMemoryError: CUDA out of memory.')).toBe(true);
    expect(isMemoryError('MemoryError')).toBe(true);
    expect(isMemoryError('读不到人声分轨：vocals.wav')).toBe(false);
    expect(isMemoryError('RVC 推理超过 600 秒')).toBe(false);
  });
});

describe('另存会话文件', () => {
  it('把成品或原声读成 base64 交给浏览器保存', async () => {
    const { invoke, dataDir } = await makeWorld();
    const { id, dir } = seedSession(dataDir, { outputs: ['out/mix-1.wav'] });
    const rec = readSession(dataDir, id)!;
    rec.source = { ...rec.source, file: 'source.mp3', bytes: 4096 };
    writeSession(dataDir, id, rec);
    writeFileSync(join(dir, 'source.mp3'), Buffer.alloc(4096, 0x44));

    const out = (await invoke('sessionFile', [id, 'output'])) as {
      name: string; ext: string; bytes: number; mime: string; base64: string;
    };
    expect(out.name).toBe(`cover-${id}.wav`);
    expect(out.ext).toBe('.wav');
    expect(out.bytes).toBe(2048);
    expect(out.mime).toBe('audio/wav');
    expect(Buffer.from(out.base64, 'base64').length).toBe(2048);

    const src = (await invoke('sessionFile', [id, 'source'])) as {
      name: string; ext: string; bytes: number; mime: string;
    };
    expect(src.ext).toBe('.mp3');
    expect(src.mime).toBe('audio/mpeg');
    expect(src.bytes).toBe(4096);
  });

  it('没有原声、没有成品、会话不存在都明确报错', async () => {
    const { invoke, dataDir } = await makeWorld();
    const full = seedSession(dataDir, { outputs: ['out/mix-1.wav'] });
    await expect(invoke('sessionFile', [full.id, 'source'])).rejects.toThrow('没有原声副本');
    const empty = seedSession(dataDir);
    await expect(invoke('sessionFile', [empty.id, 'output'])).rejects.toThrow('还没有成品');
    await expect(invoke('sessionFile', ['nope', 'output'])).rejects.toThrow('找不到会话');
  });
});

describe('闲置回收配置', () => {
  it('默认 0 分钟：升级后引擎照旧常驻', () => {
    expect(RVC_DEFAULTS.idleMinutes).toBe(0);
  });

  it('服务分组里能改，最小 0（0 表示不回收）', () => {
    const group = configGroups('zh').find((g) => g.id.endsWith(':service'));
    const prop = group?.schema.properties?.['worlds.rvc.idleMinutes'] as { type?: string; minimum?: number } | undefined;
    expect(prop?.type).toBe('number');
    expect(prop?.minimum).toBe(0);
  });
});
