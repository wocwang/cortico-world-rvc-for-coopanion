import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger, ToolOutcome, WorldHost } from 'cortico/core/types.ts';
import { RVC_DEFAULTS, configGroups, idleDelayMs } from '../src/config.ts';
import { MELBAND_FILES, UVR_MODEL_FILE } from '../src/catalog.ts';
import { createSession, readSession, writeSession, type RefineSession } from '../src/session.ts';
import { saveToLibrary } from '../src/library.ts';
import type { SongPlayer } from '../src/player.ts';
import type { WavInfo } from '../src/wav.ts';
import { RvcWorld, isMemoryError } from '../src/world.ts';
import type { BiliClient, BiliPick, SearchHit } from '../src/bili.ts';

const roots: string[] = [];
const worlds: RvcWorld[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const world of worlds.splice(0)) await world.stop();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const log: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, emit: () => {},
  child: () => log,
};

/** 起一个 World：不碰网络、不装任何东西；python 路径故意指向不存在的位置，引擎会立刻报错。 */
async function makeWorld(
  overrides: Partial<typeof RVC_DEFAULTS> = {},
  createSongPlayer?: (log: Logger) => SongPlayer,
  bili?: BiliClient,
  extraHost?: Partial<WorldHost>,
): Promise<{ world: RvcWorld; invoke: (method: string, args?: unknown[]) => Promise<unknown>; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'rvc-world-'));
  roots.push(dataDir);
  const world = new RvcWorld({
    cfg: { ...RVC_DEFAULTS, enabled: true, httpApi: false, voice: '', ...overrides },
    dataDir,
    packageDir: join(dataDir, 'pkg'),
    libraryDir: join(dataDir, 'library'),
    runtimesRoot: () => join(dataDir, 'runtimes'),
    ...(createSongPlayer ? { createSongPlayer } : {}),
    // 没注入就用一个「拒网」替身：单测永远不碰真实 B 站接口。
    bili: bili ?? {
      search: async () => { throw new Error('测试未注入 B 站客户端'); },
      fetch: async () => { throw new Error('测试未注入 B 站客户端'); },
    },
  });
  worlds.push(world);
  await world.start({ log, ...extraHost } as unknown as WorldHost);
  const decl = world.webUi('zh');
  return { world, dataDir, invoke: (method, args = []) => decl.invoke!('service', method, args) };
}

interface FakePlayer extends SongPlayer {
  cuts: number;
  files: string[];
  closed: number;
  volume: number;
  /** 模拟这一首自然播完：触发最近一次 playFile 的 onEnded。 */
  end(): void;
}

/** 假播放器：只记调用顺序，不加载原生模块、不出声。 */
function fakePlayer(): FakePlayer {
  let onEnded: (() => void) | null = null;
  const fire = (): void => {
    const end = onEnded;
    onEnded = null;
    end?.();
  };
  const state: FakePlayer = {
    cuts: 0,
    files: [],
    closed: 0,
    volume: 100,
    stop() {
      state.cuts += 1;
      fire();
    },
    playFile(path: string, hooks) {
      state.files.push(path);
      onEnded = hooks?.onEnded ?? null;
      return Promise.resolve({ durationSec: 12.5, info: {} as WavInfo });
    },
    setVolume(volume: number) { state.volume = volume; },
    close() { state.closed += 1; },
    end: fire,
  };
  return state;
}

/** 直接把 WAV 字节放进翻唱库；歌名/类型就是 `rvc_sing` 要检索的字段。 */
function seedLibrary(dataDir: string, songs: Array<{ title: string; kind: 'clean' | 'cover'; ext?: string }>): void {
  const src = join(dataDir, 'lib-src');
  mkdirSync(src, { recursive: true });
  songs.forEach((song, at) => {
    const path = join(src, `${at}${song.ext ?? '.wav'}`);
    writeFileSync(path, Buffer.alloc(128 + at));
    saveToLibrary({ root: join(dataDir, 'library'), kind: song.kind, title: song.title, sourcePath: path });
  });
}

/** 让分离模型「在位」，B 站一键翻唱的前置检查才会通过。 */
function installUvr(dataDir: string): void {
  mkdirSync(join(dataDir, 'uvr5'), { recursive: true });
  writeFileSync(join(dataDir, 'uvr5', 'UVR-MDX-NET-Inst_HQ_3.onnx'), Buffer.alloc(1024));
}

/** 造一个「看起来像」的 .pth：zip 头 + 1 MB。 */
function pth(): Buffer {
  const data = Buffer.alloc((1 << 20) + 64, 0x11);
  Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(data, 0);
  return data;
}

/** 造一个「看起来像」的 faiss 索引：IxFl 头 + 64 KB。 */
function idx(): Buffer {
  const data = Buffer.alloc((64 << 10) + 16, 0x22);
  data.write('IxFl', 0, 'ascii');
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
    expect(decl.config?.map((g) => g.id)).toEqual(['world:rvc', 'world:rvc:defaults', 'world:rvc:service']);
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

  it('卸载高质量分离只删 Mel-Band，默认模型还在', async () => {
    const { invoke, dataDir } = await makeWorld();
    const uvr5 = join(dataDir, 'uvr5');
    mkdirSync(uvr5, { recursive: true });
    writeFileSync(join(uvr5, UVR_MODEL_FILE), Buffer.alloc(64));
    const high = join(uvr5, MELBAND_FILES[0]!.path);
    writeFileSync(high, Buffer.alloc(64));
    writeFileSync(`${high}.partial`, Buffer.alloc(8));

    await invoke('removeSeparator', []);
    expect(existsSync(high)).toBe(false);
    expect(existsSync(`${high}.partial`)).toBe(false);
    expect(existsSync(join(uvr5, UVR_MODEL_FILE))).toBe(true);
  });

  it('打开翻唱库找不到资源管理器时明确报错，不静默成功', async () => {
    const nope = join(tmpdir(), `no-explorer-${Date.now()}`);
    vi.stubEnv('SystemRoot', nope);
    vi.stubEnv('WINDIR', nope);
    const { invoke } = await makeWorld();
    await expect(invoke('libraryOpen', [])).rejects.toThrow('找不到资源管理器');
  });

  it('按音色名成对添加 .pth/.index，可删除；重名会拒绝', async () => {
    const { invoke, dataDir } = await makeWorld();
    const add = (await invoke('addVoice', [
      'My Voice', 'whatever.pth', pth().toString('base64'), 'whatever.index', idx().toString('base64'),
    ])) as { name: string; voices: Array<{ name: string; index: number | null }> };
    expect(add.name).toBe('My Voice');
    expect(add.voices.map((v) => v.name)).toEqual(['My Voice']);
    expect(add.voices[0]?.index).toBeGreaterThan(0);
    expect(existsSync(join(dataDir, 'voices', 'My Voice.pth'))).toBe(true);
    expect(existsSync(join(dataDir, 'voices', 'My Voice.index'))).toBe(true);
    expect(((await invoke('state')) as { defaultVoice: string }).defaultVoice).toBe('My Voice');

    const dup = (await invoke('addVoice', ['My Voice', 'x.pth', pth().toString('base64')])) as { error?: string };
    expect(dup.error).toContain('已存在');

    const del = (await invoke('deleteVoice', ['My Voice'])) as { removed: string[]; voices: unknown[] };
    expect(del.voices).toEqual([]);
    expect(existsSync(join(dataDir, 'voices', 'My Voice.pth'))).toBe(false);
    expect(existsSync(join(dataDir, 'voices', 'My Voice.index'))).toBe(false);
    expect(((await invoke('state')) as { defaultVoice: string }).defaultVoice).toBe('');
  });

  it('分块上传大文件后安装音色，临时文件会清理', async () => {
    const { invoke, dataDir } = await makeWorld();
    const pthData = pth();
    const idxData = idx();
    const uploadId = 'test-upload-1234';
    const half = Math.ceil(pthData.length / 2);
    const chunks: Array<['pth' | 'index', number, number, Buffer]> = [
      ['pth', 0, 2, pthData.subarray(0, half)],
      ['pth', 1, 2, pthData.subarray(half)],
      ['index', 0, 1, idxData],
    ];
    for (const [kind, index, total, data] of chunks) {
      const res = (await invoke('uploadVoiceChunk', [uploadId, kind, index, total, data.toString('base64')])) as { error?: string };
      expect(res.error).toBeUndefined();
    }
    const done = (await invoke('finishVoice', ['Chunk Voice', uploadId, uploadId])) as {
      name: string;
      voices: Array<{ name: string; index: number | null }>;
    };
    expect(done.name).toBe('Chunk Voice');
    expect(done.voices[0]?.name).toBe('Chunk Voice');
    expect(done.voices[0]?.index).toBe(idxData.length);
    expect(existsSync(join(dataDir, 'voices', 'Chunk Voice.pth'))).toBe(true);
    expect(existsSync(join(dataDir, 'voices', 'Chunk Voice.index'))).toBe(true);
    expect(existsSync(join(dataDir, 'voices', `.upload-${uploadId}-pth`))).toBe(false);
    expect(existsSync(join(dataDir, 'voices', `.upload-${uploadId}-index`))).toBe(false);
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

  it('翻唱可直接传本机路径，不再把整首歌塞进 base64', async () => {
    const { invoke, dataDir } = await makeWorld();
    const song = join(dataDir, 'song.wav');
    writeFileSync(song, Buffer.alloc(64));
    // 到「分离模型未安装」说明路径已经读到了，而不是「缺少音频内容」。
    expect(await jobError(invoke, 'cover', ['song.wav', '', { path: song }])).toContain('人声分离模型未安装');
    expect(await jobError(invoke, 'cover', ['song.wav', '', { path: join(dataDir, 'nope.wav') }])).toContain('读取音频失败');
  });

  it('状态里带高质量分离开关与权重下载进度', async () => {
    const { invoke } = await makeWorld();
    const state = (await invoke('state')) as State & { highSeparator?: boolean; melband?: { phase: string } };
    expect(state.highSeparator).toBe(false);
    expect(state.melband?.phase).toBe('absent');
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
    /** 原始上传文件名；不传就是升级前的老会话。 */
    sourceName?: string;
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
    source: {
      durationSec: 12.5,
      inputPeak: 0.8,
      format: 'wav',
      ...(opts.sourceName ? { name: opts.sourceName } : {}),
    },
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

  it('没指定会话时只列清单，不自动选中最新', async () => {
    const { invoke, dataDir } = await makeWorld();
    const { id } = seedSession(dataDir);
    const listOnly = (await invoke('refineState', ['', 'list'])) as {
      session: RefineSession | null;
      sessions: Array<{ id: string }>;
    };
    expect(listOnly.session).toBeNull();
    expect(listOnly.sessions.map((s) => s.id)).toEqual([id]);

    const selected = (await invoke('refineState', [id])) as { session: RefineSession | null };
    expect(selected.session?.id).toBe(id);
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

describe('翻唱库入库', () => {
  it('把会话成品复制进库，歌名默认取原声文件名；重复入库按已存在处理', async () => {
    const { invoke, dataDir } = await makeWorld();
    const { id } = seedSession(dataDir, { outputs: ['out/clean-1.wav'], sourceName: '起风了.mp3' });
    const first = (await invoke('librarySave', [id, 'output', 0, 'clean', ''])) as {
      entry: { id: string; title: string; kind: string; bytes: number; file: string; durationSec: number };
      duplicate: boolean;
    };
    expect(first.duplicate).toBe(false);
    expect(first.entry.title).toBe('起风了');
    expect(first.entry.kind).toBe('clean');
    expect(first.entry.bytes).toBe(2048);
    expect(first.entry.durationSec).toBe(12.5);
    expect(readFileSync(join(dataDir, 'library', first.entry.file)).length).toBe(2048);

    // 面板传 -1 表示最近一条成品。
    const again = (await invoke('librarySave', [id, 'output', -1, 'clean', '起风了'])) as { duplicate: boolean };
    expect(again.duplicate).toBe(true);

    const state = (await invoke('libraryState')) as {
      entries: Array<{ id: string; kind: string; title: string; durationSec: number }>;
      totalBytes: number;
      count: number;
    };
    expect(state.count).toBe(1);
    expect(state.totalBytes).toBe(2048);
    expect(state.entries.map((e) => `${e.kind}:${e.title}`)).toEqual(['clean:起风了']);
    expect(state.entries[0]?.durationSec).toBe(12.5);

    // 面板试听拿的是 $file，不是 base64；删除后占用归零。
    const file = (await invoke('libraryFile', [first.entry.id])) as {
      $file?: { mime: string; bytes: number; sha256: string };
    };
    expect(file.$file).toMatchObject({ mime: 'audio/wav', bytes: 2048 });
    expect(file.$file?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const after = (await invoke('libraryDelete', [first.entry.id])) as { count: number; totalBytes: number };
    expect(after.count).toBe(0);
    expect(after.totalBytes).toBe(0);
  });

  it('上限来自配置：超了照常保存，只有统计标出已超', async () => {
    const { invoke, dataDir } = await makeWorld({ libraryMaxGb: 0.000001 });
    const { id } = seedSession(dataDir, { outputs: ['out/clean-1.wav'] });
    const cap = Math.round(0.000001 * 1024 * 1024 * 1024);
    const saved = (await invoke('librarySave', [id, 'output', 0, 'clean', ''])) as {
      stats: { totalBytes: number; maxBytes: number };
    };
    expect(saved.stats.maxBytes).toBe(cap);
    expect(saved.stats.totalBytes).toBe(2048);
    expect(saved.stats.totalBytes).toBeGreaterThan(saved.stats.maxBytes);
    const state = (await invoke('libraryState')) as { totalBytes: number; maxBytes: number; count: number };
    expect(state.count).toBe(1);
    expect(state.maxBytes).toBe(cap);
    expect(state.totalBytes).toBeGreaterThan(state.maxBytes);
  });

  it('保存对话框能列出全部版本；母带类型跟随会话', async () => {
    const { invoke, dataDir } = await makeWorld();
    const { id } = seedSession(dataDir, {
      outputs: ['out/mix-1.wav', 'out/clean-1.wav'],
      masters: [{ path: 'out/master-1.wav' }],
    });
    const rec = readSession(dataDir, id)!;
    rec.mix.withBgm = false;
    writeSession(dataDir, id, rec);
    const r = (await invoke('sessionFiles', [id])) as {
      files: Array<{ kind: string; index: number; format: string; bytes: number; mediaKind?: string }>;
    };
    expect(r.files.filter((file) => file.kind === 'output').map((file) => file.index).sort()).toEqual([0, 1]);
    expect(r.files.find((file) => file.kind === 'master')?.mediaKind).toBe('clean');
    expect(r.files.find((file) => file.kind === 'master')?.bytes).toBe(3072);

    // 会话当前是翻唱时，母带跟着标翻唱。
    rec.mix.withBgm = true;
    writeSession(dataDir, id, rec);
    const again = (await invoke('sessionFiles', [id])) as { files: Array<{ kind: string; mediaKind?: string }> };
    expect(again.files.find((file) => file.kind === 'master')?.mediaKind).toBe('cover');
  });

  it('清唱只收 WAV；老会话没有原声歌名时用「未命名」兜底', async () => {
    const { invoke, dataDir } = await makeWorld();
    const mp3 = seedSession(dataDir, { outputs: ['out/mix-1.mp3'] });
    await expect(invoke('librarySave', [mp3.id, 'output', 0, 'clean', ''])).rejects.toThrow('需要 WAV');
    const cover = (await invoke('librarySave', [mp3.id, 'output', 0, 'cover', ''])) as { entry: { title: string } };
    expect(cover.entry.title).toBe('未命名');
    await expect(invoke('librarySave', ['nope', 'output', 0, 'cover', ''])).rejects.toThrow('找不到会话');
    await expect(invoke('librarySave', [mp3.id, 'output', 3, 'cover', ''])).rejects.toThrow('还没有成品');
  });
});

describe('rvc_sing 桌宠点歌', () => {
  const call = async (world: RvcWorld, args: Record<string, unknown>): Promise<ToolOutcome> => {
    const tool = world.tools().find((item) => item.name === 'rvc_sing');
    expect(tool).toBeTruthy();
    return await tool!.handler(args, {} as never) as ToolOutcome;
  };

  it('注册为 speak 工具，类型只有清唱 / 翻唱且默认不传', async () => {
    const { world } = await makeWorld();
    const tool = world.tools().find((item) => item.name === 'rvc_sing')!;
    expect(tool.tags).toEqual(['speak']);
    const schema = tool.parameters as {
      properties: { kind: { enum: string[] }; song: { type: string }; source: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.kind.enum).toEqual(['clean', 'cover']);
    expect(schema.properties.source.enum).toEqual(['library', 'bilibili']);
    expect(schema.required).toEqual([]);
  });

  it('按歌名点清唱；再点明确翻唱时先停上一首', async () => {
    const player = fakePlayer();
    const { world, dataDir } = await makeWorld({}, () => player);
    seedLibrary(dataDir, [
      { title: '起风了', kind: 'cover' },
      { title: '起风了', kind: 'clean' },
    ]);
    const clean = await call(world, { song: '《起风了》' });
    expect(clean.failed).toBeUndefined();
    expect(clean.text).toContain('起风了');
    expect(clean.text).toContain('clean vocal');
    expect(clean.text).toContain('0:13');
    expect(player.files[0]).toContain('清唱cover');

    const cuts = player.cuts;
    const cover = await call(world, { song: '起风了', kind: 'cover' });
    expect(player.cuts).toBe(cuts + 1);
    expect(player.files[1]).toContain('翻唱cover');
    expect(cover.text).toContain('with backing track');
  });

  it('不给歌名时随机清唱；库为空只回文本，不算失败', async () => {
    const player = fakePlayer();
    const { world, dataDir } = await makeWorld({}, () => player);
    const empty = await call(world, {});
    expect(empty.failed).toBeUndefined();
    expect(empty.text).toContain('empty');
    expect(player.files).toHaveLength(0);

    seedLibrary(dataDir, [{ title: '晴天', kind: 'clean' }]);
    const random = await call(world, {});
    expect(random.failed).toBeUndefined();
    expect(random.text).toContain('晴天');
    expect(player.files[0]).toContain('清唱cover');
  });

  it('只有翻唱版时，清唱请求走自动生成（不偷放翻唱）；明确要翻唱才播', async () => {
    const player = fakePlayer();
    const { world, dataDir } = await makeWorld({}, () => player);
    seedLibrary(dataDir, [{ title: '稻香', kind: 'cover' }]);
    const clean = await call(world, { song: '稻香' });
    // 不再把翻唱版当清唱偷放；测试环境没有 B 站客户端，明确回失败。
    expect(clean.failed).toBe(true);
    expect(clean.text).toContain('vocal-separation model is not installed');
    expect(player.files).toHaveLength(0);

    const cover = await call(world, { song: '稻香', kind: 'cover' });
    expect(cover.failed).toBeUndefined();
    expect(player.files[0]).toContain('翻唱cover');
  });

  it('mp3 成品交给播放器转码，不再直接拒播', async () => {
    const player = fakePlayer();
    const { world, dataDir } = await makeWorld({}, () => player);
    seedLibrary(dataDir, [{ title: '七里香', kind: 'cover', ext: '.mp3' }]);
    const out = await call(world, { song: '七里香', kind: 'cover' });
    expect(out.failed).toBeUndefined();
    expect(out.text).toContain('七里香');
    expect(player.files[0]).toMatch(/\.mp3$/);
  });

  it('转码 / 出声失败时如实回失败与原因', async () => {
    const player = fakePlayer();
    player.playFile = () => Promise.reject(new Error('ffmpeg 不可用，无法把 .mp3 转成 WAV'));
    const { world, dataDir } = await makeWorld({}, () => player);
    seedLibrary(dataDir, [{ title: '七里香', kind: 'cover', ext: '.mp3' }]);
    const out = await call(world, { song: '七里香', kind: 'cover' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('ffmpeg 不可用');
  });

  it('只有相近版本时先问，不直接播；确认完整标题后才播', async () => {
    const player = fakePlayer();
    const { world, dataDir } = await makeWorld({}, () => player);
    seedLibrary(dataDir, [{ title: '雨爱 司凤版', kind: 'clean' }]);

    const ask = await call(world, { song: '雨爱' });
    expect(ask.failed).toBeUndefined();
    expect(ask.text).toContain('not an exact title');
    expect(ask.text).toContain('雨爱 司凤版');
    expect(ask.text).toContain('source "bilibili"');
    expect(player.files).toHaveLength(0);

    const yes = await call(world, { song: '雨爱 司凤版' });
    expect(yes.failed).toBeUndefined();
    expect(yes.text).toContain('Playing');
    expect(player.files[0]).toContain('清唱cover');
  });

  it('引擎停着时点歌先自动拉起；启动失败直接回原因', async () => {
    const player = fakePlayer();
    let fetched = 0;
    const { world, invoke, dataDir } = await makeWorld({ autoStart: false }, () => player, {
      search: async () => [{ bvid: 'BV0000000001', title: '起风了 官方MV', author: 'UP', durationSec: 200, play: 1_000_000 }],
      fetch: async () => { fetched += 1; throw new Error('不该下载'); },
    });
    installUvr(dataDir);
    const out = await call(world, { song: '起风了' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('could not start the RVC engine');
    expect(out.text).toContain('Python 解释器不存在');
    expect(fetched).toBe(0);
    expect(((await invoke('state')) as { phase: string }).phase).toBe('error');
  });

  it('手动停引擎后，桌宠点歌不会偷偷拉起', async () => {
    const player = fakePlayer();
    let fetched = 0;
    const { world, invoke, dataDir } = await makeWorld({ autoStart: false }, () => player, {
      search: async () => [{ bvid: 'BV0000000001', title: '起风了 官方MV', author: 'UP', durationSec: 200, play: 1_000_000 }],
      fetch: async () => { fetched += 1; throw new Error('不该下载'); },
    });
    installUvr(dataDir);
    await invoke('stop');
    const out = await call(world, { song: '起风了' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('stopped manually');
    expect(fetched).toBe(0);
    expect(((await invoke('state')) as { phase: string }).phase).toBe('stopped');
  });

  it('用户拒绝相近版本后，source=bilibili 跳过库里那一版', async () => {
    const player = fakePlayer();
    const queries: string[] = [];
    const { world, dataDir } = await makeWorld({}, () => player, {
      search: async (keyword) => { queries.push(keyword); return []; },
      fetch: async () => { throw new Error('不该下载'); },
    });
    installUvr(dataDir);
    seedLibrary(dataDir, [{ title: '雨爱 司凤版', kind: 'clean' }]);

    const out = await call(world, { song: '雨爱', source: 'bilibili' });
    expect(queries).toEqual(['雨爱']);
    expect(out.text).toContain('no results');
    expect(player.files).toHaveLength(0);
  });
});

describe('rvc_find / rvc_status / rvc_stop', () => {
  const call = async (world: RvcWorld, name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> => {
    const tool = world.tools().find((item) => item.name === name);
    expect(tool).toBeTruthy();
    return await tool!.handler(args, {} as never) as ToolOutcome;
  };

  it('rvc_find 空关键词列出全部，关键词只回匹配，可按类型过滤', async () => {
    const player = fakePlayer();
    const { world, dataDir } = await makeWorld({}, () => player);
    seedLibrary(dataDir, [
      { title: '起风了', kind: 'clean' },
      { title: '起风了 现场版', kind: 'cover' },
      { title: '晴天', kind: 'clean' },
    ]);
    const all = await call(world, 'rvc_find');
    expect(all.failed).toBeUndefined();
    expect(all.text).toContain('Saved songs (3)');
    expect(all.text).toContain('起风了 现场版');

    const hit = await call(world, 'rvc_find', { query: '起风' });
    expect(hit.text).toContain('Songs matching "起风" (2)');
    expect(hit.text).not.toContain('晴天');

    const cover = await call(world, 'rvc_find', { query: '起风', kind: 'cover' });
    expect(cover.text).toContain('(1)');
    expect(cover.text).toContain('起风了 现场版');

    const none = await call(world, 'rvc_find', { query: '不存在的歌' });
    expect(none.failed).toBeUndefined();
    expect(none.text).toContain('No saved song matches');
  });

  it('rvc_status 播放中显示歌名，rvc_stop 能停并清空状态', async () => {
    const player = fakePlayer();
    const { world, dataDir } = await makeWorld({}, () => player);
    seedLibrary(dataDir, [{ title: '晴天', kind: 'clean' }]);
    const play = await call(world, 'rvc_sing', { song: '晴天' });
    expect(play.text).toContain('Playing');

    expect(world.envPromptVars()!['rvc.playback']).toContain('currently playing "晴天"');
    const status = await call(world, 'rvc_status');
    expect(status.text).toContain('Playing "晴天"');
    expect(status.text).toContain('of 0:13');

    const cuts = player.cuts;
    const stop = await call(world, 'rvc_stop');
    expect(stop.text).toBe('Stopped "晴天".');
    expect(player.cuts).toBe(cuts + 1);
    expect(world.envPromptVars()!['rvc.playback']).toBe('nothing is playing');
    expect((await call(world, 'rvc_status')).text).toContain('Nothing is playing');
  });

  it('自然播完后播放状态回到 nothing，并推一条完成事件给宿主', async () => {
    const player = fakePlayer();
    const events: Array<{ text: string; type: string }> = [];
    const { world, dataDir } = await makeWorld({}, () => player, undefined, {
      pushEvent: (async (e: { text: string; type: string }) => {
        events.push(e);
        return e;
      }) as unknown as WorldHost['pushEvent'],
    });
    seedLibrary(dataDir, [{ title: '晴天', kind: 'clean' }]);
    await call(world, 'rvc_sing', { song: '晴天' });
    expect(world.envPromptVars()!['rvc.playback']).toContain('currently playing');
    player.end();
    expect(world.envPromptVars()!['rvc.playback']).toBe('nothing is playing');
    expect(events.map((e) => e.text)).toContain('[RVC] Playback finished: "晴天".');
  });

  it('没在播时 rvc_stop 如实说没有可停的', async () => {
    const { world } = await makeWorld();
    const out = await call(world, 'rvc_stop');
    expect(out.text).toBe('Nothing was playing.');
  });
});

describe('rvc_start / rvc_volume', () => {
  const call = async (world: RvcWorld, name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> => {
    const tool = world.tools().find((item) => item.name === name);
    expect(tool).toBeTruthy();
    return await tool!.handler(args, {} as never) as ToolOutcome;
  };

  it('rvc_volume 支持绝对值、相对值，并立即写进播放器', async () => {
    const player = fakePlayer();
    const { world, invoke } = await makeWorld({}, () => player);
    const absolute = await call(world, 'rvc_volume', { level: 60 });
    expect(absolute.text).toContain('60%');
    expect(player.volume).toBe(60);
    expect(world.envPromptVars()!['rvc.volume']).toBe('60%');

    const relative = await call(world, 'rvc_volume', { delta: 15 });
    expect(relative.text).toContain('75%');
    expect(player.volume).toBe(75);
    const read = await call(world, 'rvc_volume');
    expect(read.text).toContain('75%');

    const state = (await invoke('state')) as { volume: number };
    expect(state.volume).toBe(75);
  });

  it('rvc_start 在引擎起不来时如实回原因，并清掉手动停止的印记', async () => {
    const { world, invoke } = await makeWorld({ autoStart: false });
    await invoke('stop');
    const out = await call(world, 'rvc_start');
    expect(out.failed).toBe(true);
    expect(out.text).toContain('did not start');
    expect(out.text).not.toContain('stopped manually');
  });
});

describe('B 站一键翻唱', () => {
  const biliHit = (bvid: string, title: string): SearchHit => ({
    bvid, title, author: 'UP主', durationSec: 200, play: 1000,
  });

  it('biliSearch 低置信时回候选，不下载', async () => {
    let fetched = 0;
    const bili: BiliClient = {
      search: async () => [biliHit('BV0000000001', '起风了 官方现场版'), biliHit('BV0000000002', '起风了 官方MV')],
      fetch: async () => { fetched += 1; throw new Error('不该下载'); },
    };
    const { invoke, dataDir } = await makeWorld({}, undefined, bili);
    installUvr(dataDir);
    const pick = (await invoke('biliSearch', ['起风了'])) as BiliPick;
    expect(pick.confident).toBe(false);
    expect(pick.reason).toBe('ambiguous');
    expect(pick.candidates.map((item) => item.bvid)).toEqual(['BV0000000001', 'BV0000000002']);
    expect(fetched).toBe(0);
  });

  it('桌宠点歌库未命中 + 低置信：回候选，不下载也不播放', async () => {
    const player = fakePlayer();
    let fetched = 0;
    const bili: BiliClient = {
      search: async () => [biliHit('BV0000000001', '起风了 官方现场版'), biliHit('BV0000000002', '起风了 官方MV')],
      fetch: async () => { fetched += 1; throw new Error('不该下载'); },
    };
    const { world, dataDir } = await makeWorld({}, () => player, bili);
    installUvr(dataDir);
    const tool = world.tools().find((item) => item.name === 'rvc_sing')!;
    const out = await tool.handler({ song: '起风了' }, {} as never) as ToolOutcome;
    expect(out.text).toContain('could not pick');
    expect(out.text).toContain('起风了 官方现场版');
    expect(fetched).toBe(0);
    expect(player.files).toHaveLength(0);
  });

  it('桌宠点歌库未命中 + 分离模型未装：明确说明先安装', async () => {
    const player = fakePlayer();
    const { world } = await makeWorld({}, () => player, {
      search: async () => [biliHit('BV0000000001', '起风了 官方MV')],
      fetch: async () => { throw new Error('不该下载'); },
    });
    const tool = world.tools().find((item) => item.name === 'rvc_sing')!;
    const out = await tool.handler({ song: '起风了' }, {} as never) as ToolOutcome;
    expect(out.failed).toBe(true);
    expect(out.text).toContain('separation model');
    expect(player.files).toHaveLength(0);
  });

  it('低置信时也不把候选当歌单播；库里已有的歌仍直接播', async () => {
    const player = fakePlayer();
    const { world, dataDir } = await makeWorld({}, () => player, {
      search: async () => { throw new Error('不该搜索'); },
      fetch: async () => { throw new Error('不该下载'); },
    });
    seedLibrary(dataDir, [{ title: '起风了', kind: 'clean' }]);
    const tool = world.tools().find((item) => item.name === 'rvc_sing')!;
    const out = await tool.handler({ song: '《起风了》' }, {} as never) as ToolOutcome;
    expect(out.text).toContain('Playing');
    expect(player.files[0]).toContain('清唱cover');
  });

  it('默认类型读配置：设为翻唱时不传 kind 也唱翻唱版', async () => {
    const player = fakePlayer();
    const { world, dataDir } = await makeWorld({ singKind: 'cover' }, () => player);
    seedLibrary(dataDir, [
      { title: '起风了', kind: 'clean' },
      { title: '起风了', kind: 'cover' },
    ]);
    const tool = world.tools().find((item) => item.name === 'rvc_sing')!;
    const out = await tool.handler({ song: '起风了' }, {} as never) as ToolOutcome;
    expect(out.failed).toBeUndefined();
    expect(out.text).toContain('cover, with backing track');
    expect(player.files[0]).toContain('翻唱cover');
  });

  it('bvid 指定候选后直接使用，不再重新搜索', async () => {
    const player = fakePlayer();
    let searches = 0;
    const { world, dataDir } = await makeWorld({ autoStart: false }, () => player, {
      search: async () => { searches += 1; return []; },
      fetch: async () => { throw new Error('不该下载'); },
    });
    installUvr(dataDir);
    const tool = world.tools().find((item) => item.name === 'rvc_sing')!;
    const out = await tool.handler({ song: '晴天', bvid: 'BV0000000001' }, {} as never) as ToolOutcome;
    expect(out.failed).toBe(true);
    expect(out.text).toContain('could not start the RVC engine');
    expect(searches).toBe(0);
    expect(player.files).toHaveLength(0);
  });
});

describe('闲置回收配置', () => {
  it('默认 0 分钟：升级后引擎照旧常驻', () => {
    expect(RVC_DEFAULTS.idleMinutes).toBe(0);
  });

  it('服务分组里能改，最小 0（0 表示不回收），支持小数到秒', () => {
    const group = configGroups('zh').find((g) => g.id.endsWith(':service'));
    const prop = group?.schema.properties?.['worlds.rvc.idleMinutes'] as {
      type?: string; minimum?: number; multipleOf?: number;
    } | undefined;
    expect(prop?.type).toBe('number');
    expect(prop?.minimum).toBe(0);
    expect(prop?.multipleOf).toBeUndefined();
    expect(idleDelayMs(0.5)).toBe(30_000);
    expect(idleDelayMs(0.02)).toBe(1_200);
    expect(idleDelayMs(0)).toBe(0);
  });
});

describe('点歌与翻唱默认值配置', () => {
  it('默认值保持原有行为', () => {
    expect(RVC_DEFAULTS.singKind).toBe('clean');
    expect(RVC_DEFAULTS.panelKind).toBe('cover');
    expect(RVC_DEFAULTS.saveToLibrary).toBe(true);
    expect(RVC_DEFAULTS.keepSource).toBe(true);
    expect(RVC_DEFAULTS.mouthAnimation).toBe(true);
  });

  it('默认值分组里四项都可改', () => {
    const group = configGroups('zh').find((g) => g.id.endsWith(':defaults'));
    const props = group?.schema.properties ?? {};
    expect(props['worlds.rvc.singKind']).toMatchObject({ type: 'string', 'x-options': 'rvc:kind' });
    expect(props['worlds.rvc.panelKind']).toMatchObject({ type: 'string', 'x-options': 'rvc:kind' });
    expect(props['worlds.rvc.saveToLibrary']).toMatchObject({ type: 'boolean' });
    expect(props['worlds.rvc.keepSource']).toMatchObject({ type: 'boolean' });
    expect(props['worlds.rvc.mouthAnimation']).toMatchObject({ type: 'boolean' });
    const convert = configGroups('zh').find((g) => g.id === 'world:rvc');
    expect(convert?.schema.properties?.['worlds.rvc.voice']).toMatchObject({ 'x-options': 'rvc:voice' });
  });

  it('面板状态带回配置默认值', async () => {
    const { invoke } = await makeWorld({
      singKind: 'cover', panelKind: 'clean', saveToLibrary: false, keepSource: false,
    });
    const state = await invoke('state') as {
      defaults: { singKind: string; panelKind: string; saveToLibrary: boolean; keepSource: boolean };
    };
    expect(state.defaults).toEqual({
      singKind: 'cover', panelKind: 'clean', saveToLibrary: false, keepSource: false,
    });
  });

  it('嘴型开关写进环境变量', async () => {
    const off = await makeWorld({ mouthAnimation: false });
    expect(off.world!.envPromptVars()!['rvc.mouth']).toContain('已关闭');
    const on = await makeWorld();
    expect(on.world!.envPromptVars()!['rvc.mouth']).toContain('已开启');
  });
});
describe('静音门、气声保护与高音保护', () => {
  it('三个后处理默认都开，且都能在变声参数分组里关掉', () => {
    expect(RVC_DEFAULTS.silenceGate).toBe(true);
    expect(RVC_DEFAULTS.breathGuard).toBe(true);
    expect(RVC_DEFAULTS.highGuard).toBe(true);
    const zh = configGroups('zh').find((g) => g.id === 'world:rvc')?.schema.properties ?? {};
    expect(zh['worlds.rvc.silenceGate']).toMatchObject({ type: 'boolean' });
    expect(zh['worlds.rvc.breathGuard']).toMatchObject({ type: 'boolean' });
    expect(zh['worlds.rvc.highGuard']).toMatchObject({ type: 'boolean' });
    const en = configGroups('en').find((g) => g.id === 'world:rvc')?.schema.properties ?? {};
    expect(en['worlds.rvc.breathGuard']).toMatchObject({ type: 'boolean' });
    expect(en['worlds.rvc.highGuard']).toMatchObject({ type: 'boolean' });
  });
});

