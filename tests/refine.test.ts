import { describe, expect, it } from 'vitest';
import { MIN_RANGE_SEC, appendSegment, rangeSamples } from '../src/refine.ts';
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
