import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSession,
  dirBytes,
  gcSessions,
  listSessions,
  readSession,
  removeSession,
  sessionDir,
  writeSession,
  type RefineSession,
} from '../src/session.ts';

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'rvc-session-'));
  roots.push(dir);
  return dir;
};

const DAY = 86_400_000;

function record(id: string, updatedAt: string, voice = 'daifeiyu'): RefineSession {
  return {
    version: 1,
    id,
    createdAt: updatedAt,
    updatedAt,
    engine: { kind: 'rvc', voice, modelSampleRate: 40000 },
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
    outputs: [],
  };
}

/** 建一个 session 并写入清单；返回目录与 id。 */
function seed(data: string, updatedAt: string): { id: string; dir: string } {
  const s = createSession(data);
  writeSession(data, s.id, record(s.id, updatedAt));
  return s;
}

describe('翻唱会话', () => {
  it('新建会话一次建好 stems / vocals / out', () => {
    const data = tempDir();
    const { id, dir } = createSession(data);
    expect(id).toMatch(/^\d{8}-\d{6}-[a-f0-9]{4}$/);
    for (const sub of ['stems', 'vocals', 'out']) {
      expect(statSync(join(dir, sub)).isDirectory()).toBe(true);
    }
    expect(sessionDir(data, id)).toBe(dir);
  });

  it('清单写入后能读回，列表按更新时间倒序', () => {
    const data = tempDir();
    const older = seed(data, '2026-11-01T00:00:00.000Z');
    const newer = seed(data, '2026-11-02T00:00:00.000Z');
    writeFileSync(join(newer.dir, 'stems', 'vocals.wav'), Buffer.alloc(2048));

    expect(readSession(data, older.id)?.engine).toEqual({ kind: 'rvc', voice: 'daifeiyu', modelSampleRate: 40000 });
    const list = listSessions(data);
    expect(list.map((s) => s.id)).toEqual([newer.id, older.id]);
    expect(list[0]!.bytes).toBeGreaterThanOrEqual(2048);
  });

  it('非法 id 不落到 sessions 目录之外', () => {
    const data = tempDir();
    expect(sessionDir(data, '../escape')).toBeNull();
    expect(readSession(data, '../escape')).toBeNull();
    expect(removeSession(data, '../escape')).toBe(false);
    expect(() => writeSession(data, '../escape', record('../escape', new Date().toISOString()))).toThrow();
  });

  it('超过保留天数才删；正在用的与 10 分钟内更新的跳过', () => {
    const data = tempDir();
    const stale = seed(data, new Date(Date.now() - 8 * DAY).toISOString());
    const held = seed(data, new Date(Date.now() - 8 * DAY).toISOString());
    const recent = seed(data, new Date().toISOString());

    const got = gcSessions(data, { days: 7, maxGb: 0, keep: [held.id] });
    expect(got.removed).toEqual([stale.id]);
    expect(existsSync(stale.dir)).toBe(false);
    expect(existsSync(held.dir)).toBe(true);
    expect(existsSync(recent.dir)).toBe(true);
  });

  it('容量超限时从最旧的开始删，删够就停', () => {
    const data = tempDir();
    const older = seed(data, new Date(Date.now() - 2 * DAY).toISOString());
    const newer = seed(data, new Date(Date.now() - DAY).toISOString());
    writeFileSync(join(older.dir, 'stems', 'inst.wav'), Buffer.alloc(2000));
    writeFileSync(join(newer.dir, 'stems', 'inst.wav'), Buffer.alloc(2000));

    // 阈值卡在两个会话之间：删掉旧的即可回到上限内。
    const cap = dirBytes(newer.dir) + Math.floor(dirBytes(older.dir) / 2);
    const got = gcSessions(data, { days: 0, maxGb: cap / 1_000_000_000 });
    expect(got.removed).toEqual([older.id]);
    expect(existsSync(newer.dir)).toBe(true);
  });

  it('摘要带原声副本与成品逐文件体积；老会话的原声为 null', () => {
    const data = tempDir();
    const at = '2026-11-03T00:00:00.000Z';
    const current = seed(data, at);
    const rec = record(current.id, at);
    rec.source = { ...rec.source, file: 'source.wav', bytes: 4096 };
    rec.outputs = [
      { format: 'wav', path: 'out/mix-1.wav', at },
      { format: 'mp3', path: 'out/mix-2.mp3', at },
    ];
    writeSession(data, current.id, rec);
    writeFileSync(join(current.dir, 'source.wav'), Buffer.alloc(4096));
    writeFileSync(join(current.dir, 'out', 'mix-1.wav'), Buffer.alloc(2048));
    // mix-2 故意不写：记录还在但文件被删，体积应为 0。

    const old = seed(data, '2026-11-01T00:00:00.000Z');
    const list = listSessions(data);
    const fresh = list.find((item) => item.id === current.id)!;
    expect(fresh.source).toEqual({ file: 'source.wav', bytes: 4096 });
    expect(fresh.outputFiles).toEqual([
      { format: 'wav', path: 'out/mix-1.wav', at, bytes: 2048 },
      { format: 'mp3', path: 'out/mix-2.mp3', at, bytes: 0 },
    ]);
    expect(list.find((item) => item.id === old.id)?.source).toBeNull();
  });
});
