/**
 * 本机播放用的 WAV 头解析：只认标准 PCM16，mp3 / float 由调用方明确拒播。
 * 解析时连数据区长度一起取出来，播放时按 `dataStart + dataSize` 顺序读，不整首进内存。
 */

export interface WavInfo {
  audioFormat: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** `data` chunk 之后第一个字节在 buf 里的偏移。 */
  dataStart: number;
  /** `data` chunk 的字节数。 */
  dataSize: number;
  /** 按块长与采样率换算的秒数。 */
  durationSec: number;
}

/** 读 wav 头；不是 RIFF/WAVE 或找不到 fmt/data 时回 `null`。 */
export function parseWav(buf: Buffer): WavInfo | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let at = 12;
  let audioFormat = 0;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 24 <= buf.length) {
      audioFormat = buf.readUInt16LE(at + 8);
      channels = buf.readUInt16LE(at + 10);
      sampleRate = buf.readUInt32LE(at + 12);
      bitsPerSample = buf.readUInt16LE(at + 22);
    }
    if (id === 'data') {
      if (sampleRate <= 0 || channels <= 0) return null;
      const dataStart = at + 8;
      const dataSize = size;
      const bytesPerFrame = channels * Math.max(1, Math.round(bitsPerSample / 8));
      return {
        audioFormat,
        sampleRate,
        channels,
        bitsPerSample,
        dataStart,
        dataSize,
        durationSec: bytesPerFrame > 0 ? dataSize / bytesPerFrame / sampleRate : 0,
      };
    }
    at += 8 + size + (size & 1);
  }
  return null;
}

/** 秒数 → `m:ss`。 */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const mm = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
