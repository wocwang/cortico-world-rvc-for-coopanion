import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MIN_RANGE_SEC, appendSegment, ensureSegments, mergeSegmentWithNext, mutedRanges, rangeSamples,
  rerunSession, splitSegmentIn, type CoverEngineAdapter,
} from '../src/refine.ts';
import { createSession, defaultSegments, readSession, writeSession } from '../src/session.ts';
import type { RefineSession, RefineSegment } from '../src/session.ts';

function record(): RefineSession {
  return {
    version: 1,
    id: '20261110-000000-abcd',
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
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
    mix: {
      vocalGainDb: 0,
      instGainDb: 0,
      rmsRatio: 1.2,
      rmsFrozen: true,
      fadeInSec: 0,
      fadeOutSec: 0,
      peakScale: 0.98,
    },
    outputs: [],
  };
}

describe('rangeSamples', () => {
  it('把秒换算成整数样本，长度由端点直接相减', () => {
    expect(rangeSamples(1.5, 2.5, 44100)).toEqual({ start: 66150, end: 110250, length: 44100 });
    expect(rangeSamples(0.00001, 0.5, 8000)).toEqual({ start: 0, end: 4000, length: 4000 });
  });

  it('起点夹到 0，不做负偏移', () => {
    expect(rangeSamples(-1, 1, 1000)).toEqual({ start: 0, end: 1000, length: 1000 });
  });

  it('拒绝空区间、倒置区间与非数字', () => {
    expect(() => rangeSamples(2, 2, 44100)).toThrow();
    expect(() => rangeSamples(3, 2, 44100)).toThrow();
    expect(() => rangeSamples(Number.NaN, 2, 44100)).toThrow();
  });

  it('给了总帧数时拒绝越过文件末尾', () => {
    expect(() => rangeSamples(0, 10, 1000, 9000)).toThrow(/超出音频长度/);
    expect(rangeSamples(0, 9, 1000, 9000)).toEqual({ start: 0, end: 9000, length: 9000 });
  });
});

describe('appendSegment', () => {
  it('revision 递增、id 唯一，并刷新 updatedAt', () => {
    const session = record();
    const at = '2026-11-10T01:02:03.000Z';
    const first = appendSegment(session, 1, 2, { pitch: 2, indexRate: 0.5, protect: 0.2 }, at);
    const second = appendSegment(session, 3, 4, { pitch: -3, indexRate: 0.3, protect: 0.33 }, at);
    expect(first).toMatchObject({ id: 'r1', revision: 1, start: 1, end: 2, kind: 'range' });
    expect(second.id).toBe('r2');
    expect(session.segments.map((item: RefineSegment) => item.id)).toEqual(['r1', 'r2']);
    expect(session.updatedAt).toBe(at);
  });

  it('参数是快照，之后改对象不会污染记录', () => {
    const session = record();
    const params = { pitch: 0, indexRate: 0.3, protect: 0.33 };
    const segment = appendSegment(session, 5, 6, params);
    params.pitch = 12;
    expect(segment.params.pitch).toBe(0);
  });

  it('面板与编排共用同一个最短选区', () => {
    expect(MIN_RANGE_SEC).toBe(0.05);
  });
});

describe('defaultSegments', () => {
  const defaults = { pitch: 1, indexRate: 0.3, protect: 0.33 };

  it('按 20 秒网格切分，最后一段到时长结尾', () => {
    const at = '2026-11-10T02:00:00.000Z';
    const grid = defaultSegments(45, defaults, at);
    expect(grid.map((item) => [item.id, item.start, item.end])).toEqual([
      ['s1', 0, 20],
      ['s2', 20, 40],
      ['s3', 40, 45],
    ]);
    expect(grid.every((item) => item.kind === 'segment' && item.muted === false && item.revision === 0)).toBe(true);
    expect(grid[0].params).toEqual(defaults);
    expect(grid[0].at).toBe(at);
  });

  it('尾巴不足 1 秒并入上一段', () => {
    expect(defaultSegments(40.5, defaults).map((item) => item.end)).toEqual([20, 40.5]);
  });

  it('时长非法时返回空网格', () => {
    expect(defaultSegments(0, defaults)).toEqual([]);
    expect(defaultSegments(Number.NaN, defaults)).toEqual([]);
  });
});

describe('ensureSegments', () => {
  it('老会话补网格并返回改动标记，重复调用不再加', () => {
    const session = record();
    expect(ensureSegments(session)).toBe(true);
    expect(session.segments).toHaveLength(1);
    expect(session.segments[0]).toMatchObject({ id: 's1', start: 0, end: 12.5, kind: 'segment' });
    expect(ensureSegments(session)).toBe(false);
  });
});

describe('mutedRanges', () => {
  it('只收静音的 segment，忽略选段重跑记录', () => {
    const session = record();
    session.segments = [
      {
        id: 'r1', start: 0, end: 1, revision: 1, at: '', kind: 'range',
        params: { pitch: 0, indexRate: 0.3, protect: 0.33 },
      },
      {
        id: 's1', start: 0, end: 20, revision: 0, at: '', kind: 'segment', muted: true,
        params: { pitch: 0, indexRate: 0.3, protect: 0.33 },
      },
      {
        id: 's2', start: 20, end: 40, revision: 0, at: '', kind: 'segment', muted: false,
        params: { pitch: 0, indexRate: 0.3, protect: 0.33 },
      },
    ];
    expect(mutedRanges(session.segments)).toEqual([{ start: 0, end: 20 }]);
  });
});

describe('段落切分与合并', () => {
  const at = '2026-11-10T03:00:00.000Z';

  it('切开后两段首尾相接、继承参数、备份作废', () => {
    const session = record();
    ensureSegments(session, at);
    session.segments[0].backup = 'segments/s1.bak.wav';
    const left = splitSegmentIn(session, 's1', 6, at);
    expect(session.segments.map((item) => [item.id, item.start, item.end])).toEqual([
      ['s1', 0, 6],
      ['s2', 6, 12.5],
    ]);
    expect(left.backup).toBeUndefined();
    expect(session.segments[1].params).toEqual(left.params);
    expect(session.segments[1].kind).toBe('segment');
  });

  it('合并下一段后恢复成一段，备份作废', () => {
    const session = record();
    ensureSegments(session, at);
    splitSegmentIn(session, 's1', 6, at);
    const merged = mergeSegmentWithNext(session, 's1', at);
    expect(session.segments.map((item) => [item.id, item.start, item.end])).toEqual([['s1', 0, 12.5]]);
    expect(merged.backup).toBeUndefined();
  });

  it('切割点太近、越界或没有下一段时报错', () => {
    const session = record();
    ensureSegments(session, at);
    expect(() => splitSegmentIn(session, 's1', 0.01, at)).toThrow();
    expect(() => splitSegmentIn(session, 's1', 13, at)).toThrow();
    expect(() => mergeSegmentWithNext(session, 's1', at)).toThrow();
  });

  it('找不到段落时报错', () => {
    const session = record();
    ensureSegments(session, at);
    expect(() => splitSegmentIn(session, 's9', 6, at)).toThrow(/找不到段落/);
  });
});

describe('原地重新翻唱', () => {
  it('复用分轨重跑变声，只更新默认参数与电平比例，段落/静音/成品/母带都保留', async () => {
    const data = mkdtempSync(join(tmpdir(), 'rvc-rerun-'));
    try {
      const { id, dir } = createSession(data);
      const rec = record();
      rec.id = id;
      rec.source.file = 'source.wav';
      rec.source.bytes = 4096;
      rec.segments = defaultSegments(rec.source.durationSec, rec.converted.defaults);
      rec.segments[0].muted = true;
      rec.segments[0].revision = 3;
      rec.outputs = [{ format: 'wav', path: 'out/mix-1.wav', at: rec.createdAt }];
      rec.masters = [{
        format: 'wav', path: 'out/master-1.wav', at: rec.createdAt, targetLufs: -14,
        ceilingDb: -1, inputLufs: -20, inputTruePeakDb: -3, outputLufs: -14,
        outputTruePeakDb: -1.2, gainDb: 6, limitedDb: 0.4,
      }];
      writeSession(data, id, rec);
      for (const rel of ['stems/vocals.wav', 'stems/inst.wav', 'vocals/conv.wav']) {
        writeFileSync(join(dir, rel), Buffer.alloc(1024));
      }

      let seen: Record<string, unknown> | null = null;
      const engine: CoverEngineAdapter = {
        peaks: async () => { throw new Error('不该调用'); },
        convertRange: async () => { throw new Error('不该调用'); },
        restoreRange: async () => { throw new Error('不该调用'); },
        reconvert: async (req) => {
          seen = req as unknown as Record<string, unknown>;
          return { ms: 1234, sampleRate: 44100, rmsRatio: 2.5, modelSampleRate: 48000, durationSec: 12.5 };
        },
      };

      const result = await rerunSession(data, engine, id, { pitch: 5 });
      expect(seen).toMatchObject({
        stem: join(dir, 'stems/vocals.wav'),
        inst: join(dir, 'stems/inst.wav'),
        conv: join(dir, 'vocals/conv.wav'),
        voice: 'daifeiyu',
        pitch: 5,
        indexRate: 0.3,
        protect: 0.33,
        chunk: true,
        expectedSec: 12.5,
      });
      expect(result.session.converted.defaults).toEqual({ pitch: 5, indexRate: 0.3, protect: 0.33, chunk: true });
      expect(result.session.mix.rmsRatio).toBe(2.5);
      expect(result.session.engine.modelSampleRate).toBe(48000);
      expect(result.session.segments[0].muted).toBe(true);
      expect(result.session.segments[0].revision).toBe(3);
      expect(result.session.outputs).toHaveLength(1);
      expect(result.session.masters).toHaveLength(1);
      expect(readSession(data, id)?.converted.defaults.pitch).toBe(5);
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  it('分轨缺失时直接报错，不调用引擎', async () => {
    const data = mkdtempSync(join(tmpdir(), 'rvc-rerun-'));
    try {
      const { id, dir } = createSession(data);
      const rec = record();
      rec.id = id;
      writeSession(data, id, rec);
      writeFileSync(join(dir, 'stems/vocals.wav'), Buffer.alloc(16));
      unlinkSync(join(dir, 'stems/vocals.wav'));
      const engine: CoverEngineAdapter = {
        peaks: async () => { throw new Error('不该调用'); },
        convertRange: async () => { throw new Error('不该调用'); },
        restoreRange: async () => { throw new Error('不该调用'); },
        reconvert: async () => { throw new Error('不该调用'); },
      };
      await expect(rerunSession(data, engine, id)).rejects.toThrow(/会话缺少 stems\/vocals\.wav/);
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });
});
