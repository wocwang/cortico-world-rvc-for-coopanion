import { describe, expect, it } from 'vitest';
import { abRange, abWrap, carryPosition } from '../src/webui/ab.ts';

describe('carryPosition', () => {
  it('A/B 切换只搬播放位置，不从头播', () => {
    const a = { currentTime: 42.375, paused: false };
    const b = { currentTime: 0, paused: true };
    expect(carryPosition(a, b)).toBe(42.375);
    expect(b.currentTime).toBe(42.375);
  });

  it('位置超过时长时夹到末尾，负数归零', () => {
    const a = { currentTime: 999, paused: true };
    const b = { currentTime: 0, paused: true };
    expect(carryPosition(a, b, 60)).toBe(60);
    const c = { currentTime: -1, paused: true };
    expect(carryPosition(c, b, 60)).toBe(0);
  });
});

describe('abRange', () => {
  it('有有效选区时只循环选区', () => {
    expect(abRange(12.5, 18.25, 200)).toEqual({ start: 12.5, end: 18.25 });
  });

  it('没有选区或选区太短时退化成整首', () => {
    expect(abRange(0, 0, 200)).toEqual({ start: 0, end: 200 });
    expect(abRange(10, 10.01, 200)).toEqual({ start: 0, end: 200 });
  });

  it('选区超出时长时夹住，起始大于结束时退化成整首', () => {
    expect(abRange(190, 999, 200)).toEqual({ start: 190, end: 200 });
    expect(abRange(50, 20, 200)).toEqual({ start: 0, end: 200 });
  });
});

describe('abWrap', () => {
  it('播放越过区间终点时回到起点，没越过保持不动', () => {
    expect(abWrap(17.9, 12, 18)).toBe(17.9);
    expect(abWrap(18, 12, 18)).toBe(12);
    expect(abWrap(25, 12, 18)).toBe(12);
  });

  it('非法区间不动播放位置', () => {
    expect(abWrap(5, 10, 10)).toBe(5);
  });
});
