import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { Logger } from 'cortico/core/types.ts';
import { FfplayPlayer, type SpawnLike } from '../src/player.ts';
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

function file(bytes: Buffer, ext = '.wav'): string {
  const dir = mkdtempSync(join(tmpdir(), 'rvc-player-'));
  dirs.push(dir);
  const path = join(dir, `song${ext}`);
  writeFileSync(path, bytes);
  return path;
}

/** 本机有没有 ffmpeg；没有就跳过真实转码用例（与 worker 解 mp3 用的是同一个）。 */
function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 假播放器进程：记录参数，手动触发 spawn / exit。 */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  killed = 0;
  stderr = new EventEmitter();
  kill(): boolean {
    this.killed += 1;
    this.exitCode = 0;
    return true;
  }
}

function fakeSpawn(behavior?: (child: FakeChild) => void): { spawn: SpawnLike; calls: Array<{ cmd: string; args: string[] }>; last: () => FakeChild } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const children: FakeChild[] = [];
  const spawnFn: SpawnLike = (cmd, args) => {
    const child = new FakeChild();
    calls.push({ cmd, args });
    children.push(child);
    setImmediate(() => {
      child.emit('spawn');
      behavior?.(child);
    });
    return child as unknown as ChildProcess;
  };
  return { spawn: spawnFn, calls, last: () => children[children.length - 1]! };
}

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

describe('ffplay 播放器', () => {
  it('默认带 -volume 100，改音量后新歌用新值', async () => {
    const fake = fakeSpawn();
    const player = new FfplayPlayer(log, { spawn: fake.spawn });
    player.setVolume(60);
    await player.playFile(file(wav({ seconds: 0.2 })));
    expect(fake.calls[0]?.args).toEqual(expect.arrayContaining(['-volume', '60']));
    player.close();
  });

  it('播放中改音量：杀掉旧进程并从当前位置按新音量重开', async () => {
    const fake = fakeSpawn();
    const player = new FfplayPlayer(log, { spawn: fake.spawn, startGraceMs: 0 });
    await player.playFile(file(wav({ seconds: 10 })));
    const first = fake.last();
    player.setVolume(30);
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(first.killed).toBe(1);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.args).toEqual(expect.arrayContaining(['-volume', '30']));
    expect(fake.calls[1]?.args).toEqual(expect.arrayContaining(['-ss']));
    player.close();
  });

  it('用外部 ffplay 打开 WAV，停止时杀掉进程', async () => {
    const fake = fakeSpawn();
    const player = new FfplayPlayer(log, { spawn: fake.spawn });
    const done = await player.playFile(file(wav({ seconds: 0.2 })));
    expect(done.durationSec).toBeCloseTo(0.2, 2);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.cmd).toBe('ffplay');
    expect(fake.calls[0]?.args).toEqual(expect.arrayContaining(['-nodisp', '-autoexit']));
    expect(fake.calls[0]?.args.at(-1)).toMatch(/song\.wav$/);
    const child = fake.last();
    player.stop();
    expect(child.killed).toBe(1);
    player.close();
    // 已经停过就不再重复 kill。
    expect(child.killed).toBe(1);
  });

  it('再点一首先杀上一首的进程', async () => {
    const fake = fakeSpawn();
    const player = new FfplayPlayer(log, { spawn: fake.spawn });
    await player.playFile(file(wav({ seconds: 0.2 })));
    const first = fake.last();
    await player.playFile(file(wav({ seconds: 0.2, channels: 2 })));
    expect(first.killed).toBe(1);
    expect(fake.calls).toHaveLength(2);
    player.close();
  });

  it('启动即非零退出时把 stderr 带回来', async () => {
    const fake = fakeSpawn((child) => {
      child.emit('spawn');
      child.stderr.emit('data', Buffer.from('Could not initialize SDL - No available audio device'));
      child.exitCode = 1;
      child.emit('exit', 1, null);
    });
    const player = new FfplayPlayer(log, { spawn: fake.spawn, startGraceMs: 20 });
    await expect(player.playFile(file(wav({ seconds: 0.1 })))).rejects.toThrow(/立即退出.*audio device/s);
  });

  it('ffplay 不可用时明确说清，不悄悄静音', async () => {
    const player = new FfplayPlayer(log, { ffplay: join(tmpdir(), 'no-such-ffplay.exe') });
    await expect(player.playFile(file(wav({ seconds: 0.1 })))).rejects.toThrow(/ffplay 不可用/);
  });

  it('非 WAV / 非 PCM16 明确报错，不调起播放器', async () => {
    const fake = fakeSpawn();
    const player = new FfplayPlayer(log, { spawn: fake.spawn });
    await expect(player.playFile(file(Buffer.from('ID3 fake mp3')))).rejects.toThrow('WAV');
    await expect(player.playFile(file(wav({ format: 3 })))).rejects.toThrow('PCM');
    expect(fake.calls).toHaveLength(0);
    player.close();
  });

  it('ffmpeg 不可用时明确说清，不悄悄静音', async () => {
    const fake = fakeSpawn();
    const player = new FfplayPlayer(log, {
      spawn: fake.spawn,
      ffmpeg: join(tmpdir(), 'no-such-ffmpeg.exe'),
    });
    await expect(player.playFile(file(Buffer.from('ID3 fake mp3'), '.mp3'))).rejects.toThrow('ffmpeg 不可用');
    expect(fake.calls).toHaveLength(0);
    player.close();
  });

  it.skipIf(!hasFfmpeg())('mp3 先用 ffmpeg 转临时 WAV 再交给 ffplay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rvc-player-mp3-'));
    dirs.push(dir);
    const source = join(dir, 'source.wav');
    writeFileSync(source, wav({ seconds: 0.3 }));
    const mp3 = join(dir, 'song.mp3');
    execFileSync('ffmpeg', ['-nostdin', '-y', '-i', source, '-c:a', 'libmp3lame', '-b:a', '128k', mp3], { stdio: 'ignore' });

    const fake = fakeSpawn();
    const player = new FfplayPlayer(log, { spawn: fake.spawn });
    const done = await player.playFile(mp3);
    expect(done.durationSec).toBeGreaterThan(0.2);
    expect(fake.calls[0]?.args.at(-1)).toMatch(/rvc-play-.*song\.wav$/);
    player.close();
  });
});
