import { describe, expect, it } from 'vitest';
import { segmentWindow } from '../src/webui/preview.ts';

describe('段落试听的窗口', () => {
  it('默认前后各留 0.3 秒上下文', () => {
    expect(segmentWindow(20, 40, 120)).toEqual({ from: 19.7, to: 40.3 });
  });

  it('开头不越界，末尾夹到整首时长', () => {
    expect(segmentWindow(0, 20, 120)).toEqual({ from: 0, to: 20.3 });
    expect(segmentWindow(100, 120, 120)).toEqual({ from: 99.7, to: 120 });
  });

  it('时长未知时只用段落边界推窗口', () => {
    expect(segmentWindow(5, 10, 0)).toEqual({ from: 4.7, to: 10.3 });
  });

  it('比整首还长的段落不产生负窗口', () => {
    const w = segmentWindow(30, 400, 120);
    expect(w.from).toBe(29.7);
    expect(w.to).toBe(120);
  });
});
