/**
 * A/B 试听的纯逻辑：把「当前播放位置」从一条音轨交给另一条。
 *
 * 面板里 A/B 是两个 `<audio>` 元素（改动前 / 改动后）。切换时不能从头播，
 * 必须把 `currentTime` 原样搬过去；这段逻辑单独放这里，便于单测。
 */

export interface MediaLike {
  currentTime: number;
  paused: boolean;
}

/** 把 from 的播放位置搬到 to，返回实际落点（秒）。超出 to 的时长时夹到末尾。 */
export function carryPosition(from: MediaLike, to: MediaLike, duration = Number.POSITIVE_INFINITY): number {
  const limit = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  const at = Math.max(0, Math.min(from.currentTime, limit));
  to.currentTime = at;
  return at;
}

/** 选区 A/B 的循环边界；选区非法时退化成整首。 */
export function abRange(start: number, end: number, duration: number): { start: number; end: number } {
  if (!(duration > 0)) return { start: 0, end: 0 };
  const from = Number.isFinite(start) ? Math.max(0, Math.min(start, duration)) : 0;
  const to = Number.isFinite(end) ? Math.max(from, Math.min(end, duration)) : duration;
  if (to - from < 0.05) return { start: 0, end: duration };
  return { start: from, end: to };
}

/** 播放越过区间终点时回到起点；没越过返回原位置。 */
export function abWrap(position: number, start: number, end: number): number {
  if (!(end > start) || position < end) return position;
  return start;
}

/**
 * 每帧算「要不要 seek」：只有真的越过终点才返回落点，否则返回 null。
 *
 * 不要每帧都写 `currentTime`——即使写的是同一个值，浏览器也会当成一次 seek，
 * 反复重解码会让播放听起来变慢/一顿一顿。
 */
export function abSeek(position: number, start: number, end: number): number | null {
  const next = abWrap(position, start, end);
  return next === position ? null : next;
}
