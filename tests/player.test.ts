import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from 'cortico/core/types.ts';
import { BackgroundSongPlayer, convertChannels, type AudioSink } from '../src/player.ts';
import { clock, parseWav } from '../src/wav.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const log: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, emit: () => {},
  child: () => log,
};

interface WavOptions {
  seconds?: number;
  channels?: number;
  sampleRate?: number;
  bits?: number;
  format?: number;
}

/** 造一段 PCM WAV；样本内容不参与断言，只关心块长与格式。 */
function wav(opts: WavOptions = {}): Buffer {
  const { seconds = 0.2, channels = 1, sampleRate = 44100, bits = 16, format = 1 } = opts;
  const bytesPerFrame = channels * (bits / 8);
  const data = Buffer.alloc(Math.round(sampleRate * seconds) * bytesPerFrame);
  for (let at = 0; at + 1 < data.length; at += 2) data.writeInt16LE(1200, at);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(format, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * bytesPerFrame, 28);
  head.writeUInt16LE(bytesPerFrame, 32);
  head.writeUInt16LE(bits, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

function file(bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'rvc-player-'));
  dirs.push(dir);
  const path = join(dir, 'song.wav');
  writeFileSync(path, bytes);
  return path;
}

class FakeSink implements AudioSink {
  writes: Array<{ bytes: number; channels: number; sampleRate: number }> = [];
  cuts = 0;
  flushes = 0;
  closed = 0;
  async write(sampleRate: number, pcm: Buffer, channels: number): Promise<void> {
    this.writes.push({ bytes: pcm.length, channels, sampleRate });
  }
  flush(): void { this.flushes += 1; }
  cut(): void { this.cuts += 1; }
  close(): void { this.closed += 1; }
}

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

describe('WAV 头', () => {
  it('取出采样率、声道、位深与数据区', () => {
    const info = parseWav(wav({ seconds: 0.5, channels: 2 }));
    expect(info?.sampleRate).toBe(44100);
    expect(info?.channels).toBe(2);
    expect(info?.bitsPerSample).toBe(16);
    expect(info?.dataSize).toBe(44100 * 0.5 * 4);
    expect(info?.durationSec).toBeCloseTo(0.5, 3);
    expect(parseWav(Buffer.from('not a wav'))).toBeNull();
  });

  it('时长显示成 m:ss', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(61.4)).toBe('1:01');
    expect(clock(3599)).toBe('59:59');
  });
});

describe('声道转换', () => {
  it('单声道复制成两路，立体声平均成一路', () => {
    const mono = Buffer.alloc(4);
    mono.writeInt16LE(1000, 0);
    mono.writeInt16LE(-1000, 2);
    const stereo = convertChannels(mono, 1, 2);
    expect(stereo.readInt16LE(0)).toBe(1000);
    expect(stereo.readInt16LE(2)).toBe(1000);
    expect(stereo.readInt16LE(4)).toBe(-1000);
    expect(stereo.readInt16LE(6)).toBe(-1000);
    const back = convertChannels(stereo, 2, 1);
    expect(back.readInt16LE(0)).toBe(1000);
    expect(back.readInt16LE(2)).toBe(-1000);
  });
});

describe('背景播放', () => {
  it('第一块写进输出流就返回，播完补齐尾巴', async () => {
    const sink = new FakeSink();
    const player = new BackgroundSongPlayer(sink, log);
    const done = await player.playFile(file(wav({ seconds: 0.2 })));
    expect(done.durationSec).toBeCloseTo(0.2, 2);
    expect(sink.writes).toHaveLength(1);
    expect(sink.writes[0]).toMatchObject({ channels: 1, sampleRate: 44100 });
    await wait(20);
    expect(sink.flushes).toBe(1);
    player.close();
    expect(sink.closed).toBe(1);
  });

  it('播立体声时把声道数交给 sink', async () => {
    const sink = new FakeSink();
    const player = new BackgroundSongPlayer(sink, log);
    await player.playFile(file(wav({ seconds: 0.1, channels: 2 })));
    expect(sink.writes[0]?.channels).toBe(2);
    player.close();
  });

  it('再点一首先停上一首：旧循环不再写', async () => {
    const sink = new FakeSink();
    const player = new BackgroundSongPlayer(sink, log);
    await player.playFile(file(wav({ seconds: 5 })));
    const before = sink.writes.length;
    expect(before).toBeGreaterThan(0);
    player.stop();
    expect(sink.cuts).toBeGreaterThan(0);
    await wait(40);
    expect(sink.writes).toHaveLength(before);
    player.close();
  });

  it('非 WAV / 非 PCM16 明确报错', async () => {
    const player = new BackgroundSongPlayer(new FakeSink(), log);
    await expect(player.playFile(file(Buffer.from('ID3 fake mp3')))).rejects.toThrow('WAV');
    await expect(player.playFile(file(wav({ format: 3 })))).rejects.toThrow('PCM');
    player.close();
  });
});
