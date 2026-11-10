/**
 * 只读音高分析：把 worker 导出的 `time,f0` 帧序列变成「叠加曲线 + 跑调区间」。
 *
 * 判据（面板与文档用的是同一组常量，不用魔法数字）：
 * 1. 每帧先算它离**最近十二平均律音**的音分偏差（A4 = 440 Hz）；
 * 2. 用所有有声音帧的中位数当整首歌的调音偏移，先减掉它——录成 432 Hz 或
 *    磁带轻微变调的素材不该整首被判跑调；
 * 3. 对偏差做 90 ms 中值滤波（9 帧 @100 fps），压掉颤音造成的锯齿；
 *    颤音通常 ±20–50 音分、5–7 Hz，中值滤波后只剩音符中心；
 * 4. 滤波后连续 ≥ 8 帧（80 ms）偏差绝对值 ≥ 35 音分，才算一个跑调区间。
 *    35 音分约为三分之一半音，是「能明显听出来、但还没到换音」的保守阈值。
 *
 * 这里只做判断，不改 f0、不生成 f0 文件、不碰 vendor/rvc。
 */

/** 跑调阈值：离音符中心 35 音分（≈1/3 半音）。 */
export const PITCH_CENTS_THRESHOLD = 35;
/** 最短跑调区间：8 帧，10 ms 一帧即 80 ms。 */
export const PITCH_MIN_REGION_FRAMES = 8;
/** 中值滤波窗：9 帧，90 ms。 */
export const PITCH_MEDIAN_FRAMES = 9;
/** 相邻跑调帧允许的断点数；断 3 帧以上算两段。 */
const PITCH_MAX_GAP_FRAMES = 2;
/** 面板曲线最多返回的点数，避免三分钟的歌把 JSON 撑大。 */
const DEFAULT_MAX_CURVE_POINTS = 2400;

export interface F0Frame {
  /** 秒。 */
  t: number;
  /** Hz；0 表示这一帧没检测到人声。 */
  f0: number;
}

export interface PitchThresholds {
  cents: number;
  minRegionFrames: number;
  medianFrames: number;
}

export interface PitchRegion {
  /** 秒。 */
  start: number;
  end: number;
  /** 区间内滤波后偏差的均值（正=偏高）。 */
  meanCents: number;
  /** 区间内绝对值最大的偏差。 */
  maxCents: number;
  frames: number;
}

export interface PitchCurve {
  times: number[];
  /** 该桶的有声音高中位数；0 表示整桶都无音高。 */
  f0: number[];
  /** 该桶里绝对值最大的滤波后偏差；无音高为 null。 */
  cents: Array<number | null>;
}

export interface PitchAnalysis {
  frames: number;
  frameRate: number;
  durationSec: number;
  /** 有音高帧占比。 */
  voicedRatio: number;
  /** 有音高帧中，偏差在阈值内的占比。 */
  inTuneRatio: number;
  /** 整首歌估计的调音偏移（音分）；判跑调前已经减掉。 */
  tuningOffsetCents: number;
  thresholds: PitchThresholds;
  curve: PitchCurve;
  regions: PitchRegion[];
  /** 全部跑调区间数；`regions` 最多保留前 200 个。 */
  regionCount: number;
}

/** 解析 worker 写的 CSV；坏行跳过，不抛。 */
export function parseF0Csv(text: string): F0Frame[] {
  const frames: F0Frame[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('time,')) continue;
    const comma = line.indexOf(',');
    if (comma <= 0) continue;
    const t = Number(line.slice(0, comma));
    const f0 = Number(line.slice(comma + 1));
    if (!Number.isFinite(t) || !Number.isFinite(f0)) continue;
    frames.push({ t, f0 });
  }
  return frames;
}

/** 离最近十二平均律音的音分偏差，范围 (-50, +50]。 */
export function semitoneCents(f0: number): number {
  if (!(f0 > 0) || !Number.isFinite(f0)) return 0;
  const midi = Math.round(69 + 12 * Math.log2(f0 / 440));
  const reference = 440 * 2 ** ((midi - 69) / 12);
  return 1200 * Math.log2(f0 / reference);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 对「有声音帧」序列做中值滤波；窗宽是帧数，边界处用可用帧。 */
function medianFilter(values: number[], width: number): number[] {
  const half = Math.max(1, Math.floor(width / 2));
  return values.map((_, index) => {
    const from = Math.max(0, index - half);
    const to = Math.min(values.length, index + half + 1);
    return median(values.slice(from, to));
  });
}

/**
 * 分析整首音高。
 * @param frames worker 导出的帧序列（10 ms 一帧）
 * @param frameRate 帧率，默认 100
 */
export function analyzePitch(
  frames: F0Frame[],
  frameRate = 100,
  maxCurvePoints = DEFAULT_MAX_CURVE_POINTS,
): PitchAnalysis {
  const total = frames.length;
  const thresholds: PitchThresholds = {
    cents: PITCH_CENTS_THRESHOLD,
    minRegionFrames: PITCH_MIN_REGION_FRAMES,
    medianFrames: PITCH_MEDIAN_FRAMES,
  };
  const empty: PitchAnalysis = {
    frames: total,
    frameRate,
    durationSec: total / frameRate,
    voicedRatio: 0,
    inTuneRatio: 0,
    tuningOffsetCents: 0,
    thresholds,
    curve: { times: [], f0: [], cents: [] },
    regions: [],
    regionCount: 0,
  };
  if (!total) return empty;

  const voicedIndex: number[] = [];
  const raw: number[] = [];
  for (let i = 0; i < total; i += 1) {
    const f0 = frames[i].f0;
    if (f0 > 0 && Number.isFinite(f0)) {
      voicedIndex.push(i);
      raw.push(semitoneCents(f0));
    }
  }
  if (!voicedIndex.length) return empty;

  const tuningOffsetCents = Number(median(raw).toFixed(2));
  const centered = raw.map((value) => value - tuningOffsetCents);
  const filtered = medianFilter(centered, PITCH_MEDIAN_FRAMES);

  // 逐帧标记，再按「断点 ≤ 2 帧」聚成区间。
  const flagged = filtered.map((value) => Math.abs(value) >= PITCH_CENTS_THRESHOLD);
  const regions: PitchRegion[] = [];
  let startPos = -1;
  let lastPos = -1;
  const flush = (): void => {
    if (startPos < 0) return;
    const count = lastPos - startPos + 1;
    if (count >= PITCH_MIN_REGION_FRAMES) {
      const values = filtered.slice(startPos, lastPos + 1);
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      let maxCents = values[0];
      for (const value of values) if (Math.abs(value) > Math.abs(maxCents)) maxCents = value;
      const first = voicedIndex[startPos];
      const last = voicedIndex[lastPos];
      regions.push({
        start: Number(frames[first].t.toFixed(3)),
        end: Number(frames[last].t.toFixed(3)),
        meanCents: Number(mean.toFixed(1)),
        maxCents: Number(maxCents.toFixed(1)),
        frames: count,
      });
    }
    startPos = -1;
    lastPos = -1;
  };
  for (let pos = 0; pos < flagged.length; pos += 1) {
    if (!flagged[pos]) continue;
    if (startPos < 0) {
      startPos = pos;
      lastPos = pos;
      continue;
    }
    const gap = voicedIndex[pos] - voicedIndex[lastPos] - 1;
    if (gap > PITCH_MAX_GAP_FRAMES) {
      flush();
      startPos = pos;
    }
    lastPos = pos;
  }
  flush();

  // 曲线按桶降采样；热力条用桶内最差偏差，能保留短促的跑调。
  const bucketSize = Math.max(1, Math.ceil(total / Math.max(1, maxCurvePoints)));
  const times: number[] = [];
  const curveF0: number[] = [];
  const curveCents: Array<number | null> = [];
  const positionByFrame = new Map<number, number>();
  voicedIndex.forEach((frame, pos) => positionByFrame.set(frame, pos));
  for (let from = 0; from < total; from += bucketSize) {
    const to = Math.min(total, from + bucketSize);
    const hz: number[] = [];
    let worst: number | null = null;
    for (let frame = from; frame < to; frame += 1) {
      const pos = positionByFrame.get(frame);
      if (pos === undefined) continue;
      const f0 = frames[frame].f0;
      if (f0 > 0) hz.push(f0);
      const value = filtered[pos];
      if (worst === null || Math.abs(value) > Math.abs(worst)) worst = value;
    }
    times.push(Number(frames[from].t.toFixed(2)));
    curveF0.push(hz.length ? Number(median(hz).toFixed(1)) : 0);
    curveCents.push(worst === null ? null : Number(worst.toFixed(1)));
  }

  let inTune = 0;
  for (const value of filtered) if (Math.abs(value) < PITCH_CENTS_THRESHOLD) inTune += 1;

  return {
    frames: total,
    frameRate,
    durationSec: total / frameRate,
    voicedRatio: Number((voicedIndex.length / total).toFixed(3)),
    inTuneRatio: Number((inTune / filtered.length).toFixed(3)),
    tuningOffsetCents,
    thresholds,
    curve: { times, f0: curveF0, cents: curveCents },
    regions: regions.slice(0, 200),
    regionCount: regions.length,
  };
}
