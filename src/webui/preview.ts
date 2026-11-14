/** 段落试听的播放窗口：前后各留 pad 秒上下文，并夹在整首时长内。 */
export interface PreviewWindow {
  from: number;
  to: number;
}

export function segmentWindow(start: number, end: number, duration: number, pad = 0.3): PreviewWindow {
  const limit = duration > 0 ? duration : Math.max(0, end + pad);
  const from = Math.max(0, Math.min(start, limit) - pad);
  const to = Math.min(limit, Math.max(end, from) + pad);
  return { from, to: Math.max(from, to) };
}
