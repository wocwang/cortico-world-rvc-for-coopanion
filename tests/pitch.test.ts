import { describe, expect, it } from 'vitest';
import {
  PITCH_CENTS_THRESHOLD, analyzePitch, parseF0Csv, semitoneCents,
} from '../src/pitch.ts';
import type { F0Frame } from '../src/pitch.ts';

const RATE = 100;

function hz(midi: number, cents = 0): number {
  return 440 * 2 ** ((midi - 69) / 12) * 2 ** (cents / 1200);
}

function frames(count: number, midi: number, cents = 0, from = 0): F0Frame[] {
  return Array.from({ length: count }, (_, index) => ({
    t: Number((from + index / RATE).toFixed(3)),
    f0: hz(midi, cents),
  }));
}

describe('semitoneCents', () => {
  it('音高正好在十二平均律上时偏差为 0，偏高 40 音分就是 40', () => {
    expect(semitoneCents(440)).toBeCloseTo(0, 6);
    expect(semitoneCents(440 * 2 ** (40 / 1200))).toBeCloseTo(40, 6);
    expect(semitoneCents(440 * 2 ** (-40 / 1200))).toBeCloseTo(-40, 6);
  });

  it('无音高帧返回 0，不抛错', () => {
    expect(semitoneCents(0)).toBe(0);
    expect(semitoneCents(Number.NaN)).toBe(0);
  });
});

describe('parseF0Csv', () => {
  it('跳过表头与坏行，保留有限数值', () => {
    const rows = parseF0Csv('time,f0\n0.00,0\n0.01,440.5\nbad\n0.03,NaN\n');
    expect(rows).toEqual([{ t: 0, f0: 0 }, { t: 0.01, f0: 440.5 }]);
  });
});

describe('analyzePitch', () => {
  it('整段标准音高：没有跑调区间', () => {
    const result = analyzePitch(frames(200, 69), RATE);
    expect(result.regionCount).toBe(0);
    expect(result.inTuneRatio).toBe(1);
    expect(result.voicedRatio).toBe(1);
    expect(result.tuningOffsetCents).toBe(0);
  });

  it('中间 1 秒偏高 45 音分：定位到该区间且不被两端带偏', () => {
    const input = [...frames(100, 69), ...frames(100, 69, 45, 1), ...frames(100, 69, 0, 2)];
    const result = analyzePitch(input, RATE);
    expect(result.regionCount).toBe(1);
    const [region] = result.regions;
    expect(region.start).toBeGreaterThanOrEqual(1);
    expect(region.start).toBeLessThan(1.15);
    expect(region.end).toBeGreaterThan(1.85);
    expect(region.end).toBeLessThanOrEqual(2);
    expect(region.meanCents).toBeCloseTo(45, 0);
    expect(result.tuningOffsetCents).toBeCloseTo(0, 0);
  });

  it('整首录低了 40 音分：先扣调音偏移，不判成整首跑调', () => {
    const result = analyzePitch(frames(300, 69, -40), RATE);
    expect(result.regionCount).toBe(0);
    expect(result.inTuneRatio).toBe(1);
    expect(result.tuningOffsetCents).toBeCloseTo(-40, 1);
  });

  it('50 ms 的瞬时偏高不报：低于 80 ms 最短区间', () => {
    const input = [
      ...frames(100, 69),
      ...Array.from({ length: 5 }, (_, index) => ({ t: (100 + index) / RATE, f0: hz(69, 60) })),
      ...frames(100, 69, 0, 1.05),
    ];
    expect(analyzePitch(input, RATE).regionCount).toBe(0);
  });

  it('颤音 ±30 音分被 90 ms 中值滤波压掉，不报跑调', () => {
    const input = Array.from({ length: 400 }, (_, index) => ({
      t: index / RATE,
      f0: hz(69, 30 * Math.sin(2 * Math.PI * 6 * index / RATE)),
    }));
    const result = analyzePitch(input, RATE);
    expect(result.regionCount).toBe(0);
    expect(result.inTuneRatio).toBe(1);
  });

  it('无音高帧不计入分母，也不产生区间', () => {
    const input = Array.from({ length: 200 }, (_, index) => ({
      t: index / RATE,
      f0: index < 100 || index >= 150 ? 0 : hz(69, 50),
    }));
    const result = analyzePitch(input, RATE);
    expect(result.voicedRatio).toBeCloseTo(0.25, 2);
    expect(result.regionCount).toBe(0);
  });

  it('阈值常量与区间下限对外可见，面板展示的不是魔法数字', () => {
    const result = analyzePitch(frames(100, 69), RATE);
    expect(result.thresholds.cents).toBe(PITCH_CENTS_THRESHOLD);
    expect(result.thresholds.minRegionFrames).toBe(8);
    expect(result.thresholds.medianFrames).toBe(9);
  });

  it('曲线按桶降采样，热力条取桶内最差偏差', () => {
    const input = [...frames(100, 69), ...frames(50, 69, 50, 1)];
    const result = analyzePitch(input, RATE, 10);
    expect(result.curve.times.length).toBeLessThanOrEqual(11);
    expect(result.curve.cents.some((value) => value !== null && Math.abs(value) >= PITCH_CENTS_THRESHOLD)).toBe(true);
  });
});
