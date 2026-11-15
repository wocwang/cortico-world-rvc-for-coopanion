/**
 * 翻唱库的本机播放：背景按 1 秒一块读 WAV，按播放进度喂给 audify(RtAudio)。
 *
 * 工具 `rvc_sing` 只等第一块 PCM 进输出流就回执，不阻塞整首；再点歌先 `stop()`，
 * 关流丢掉队列里没播的部分。WAV 只收 PCM16（单声道或立体声），其它格式明确拒播。
 */
import { execFile } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import { parseWav, type WavInfo } from './wav.ts';

interface RtAudioLike {
  openStream(
    out: { deviceId: number; nChannels: number; firstChannel: number },
    input: null,
    format: number,
    sampleRate: number,
    frameSize: number,
    streamName: string,
    inputCallback: null,
    frameOutputCallback: null,
  ): void;
  closeStream(): void;
  start(): void;
  write(buf: Buffer): void;
  getDevices(): Array<{ id: number; name: string; outputChannels: number }>;
  getDefaultOutputDevice(): number;
  isStreamOpen(): boolean;
}

interface AudifyModule {
  RtAudio: new (api?: number) => RtAudioLike;
  RtAudioFormat: { RTAUDIO_SINT16: number };
  RtAudioApi: { WINDOWS_WASAPI: number };
}

/** 每次写入的帧长：20 ms。 */
const FRAME_MS = 20;
/** 播放时保持的预读量：最多比实时早 2 秒，别把整首塞进输出队列。 */
const LEAD_MS = 2000;
const CHUNK_SEC = 1;
const STREAM_NAME = 'cortico-world-rvc';
const HEADER_BYTES = 256 * 1024;

/** 播放器接口：单测里换成假实现，不加载原生模块。 */
export interface AudioSink {
  write(sampleRate: number, pcm: Buffer, channels: number): Promise<void>;
  flush(): void;
  cut(): void;
  close(): void;
}

export interface SongPlayer {
  /** 停下当前歌曲（关流、丢弃队列）。 */
  stop(): void;
  /** 从头播放一个音频；第一块 PCM 写进输出流后返回。 */
  playFile(path: string): Promise<{ durationSec: number; info: WavInfo }>;
  /** 停播并关掉输出流。 */
  close(): void;
}

export interface PlayerOptions {
  /** ffmpeg 可执行文件；默认走 PATH（worker 解 mp3 用的也是它）。 */
  ffmpeg?: string;
}

/** 把浏览器能播、audify 播不了的格式转成临时 WAV；用完删目录。 */
function convertToWav(input: string, output: string, ffmpeg: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpeg,
      ['-nostdin', '-y', '-i', input, '-vn', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', output],
      { windowsHide: true, timeout: 120_000 },
      (err, _stdout, stderr) => {
        if (!err) {
          resolve();
          return;
        }
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
        const tail = String(stderr || err.message).trim().split(/\r?\n/).slice(-1)[0] ?? '';
        reject(new Error(missing
          ? `ffmpeg 不可用，无法把 ${extname(input) || '这个格式'} 转成 WAV`
          : `ffmpeg 转换失败：${tail}`));
      },
    );
  });
}

function removeTemp(dir: string | null): void {
  if (!dir) return;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 还在播或已删 */ }
}

/** 单声道 / 立体声互转：输出声道多就复制，少就平均。 */
export function convertChannels(pcm: Buffer, from: number, to: number): Buffer {
  if (from === to || from < 1 || to < 1) return pcm;
  if (from === 1 && to === 2) {
    const out = Buffer.alloc(pcm.length * 2);
    for (let i = 0, o = 0; i + 1 < pcm.length; i += 2, o += 4) {
      out[o] = pcm[i]!;
      out[o + 1] = pcm[i + 1]!;
      out[o + 2] = pcm[i]!;
      out[o + 3] = pcm[i + 1]!;
    }
    return out;
  }
  if (from === 2 && to === 1) {
    const out = Buffer.alloc(pcm.length / 2);
    for (let i = 0, o = 0; i + 3 < pcm.length; i += 4, o += 2) {
      const mixed = Math.round((pcm.readInt16LE(i) + pcm.readInt16LE(i + 2)) / 2);
      out.writeInt16LE(mixed, o);
    }
    return out;
  }
  return pcm;
}

const apiOf = (a: AudifyModule): number | undefined => (process.platform === 'win32' ? a.RtAudioApi.WINDOWS_WASAPI : undefined);

/** 用到时才加载：随包带 audify 的 napi win32-x64 预编译件（`vendor/audify/`）。 */
function loadAudify(): AudifyModule {
  const binding = createRequire(import.meta.url)('../vendor/audify/audify.node') as Pick<AudifyModule, 'RtAudio'>;
  return { RtAudio: binding.RtAudio, RtAudioFormat: { RTAUDIO_SINT16: 0x2 }, RtAudioApi: { WINDOWS_WASAPI: 7 } };
}

/** audify 输出流：统一成设备声道数后按 20 ms 一帧写入。 */
export class AudifySink implements AudioSink {
  private audify: AudifyModule | null = null;
  private rt: RtAudioLike | null = null;
  private rate = 0;
  private channels = 1;
  private frameBytes = 0;
  private carry = Buffer.alloc(0);

  constructor(private readonly log: Logger) {}

  async write(sampleRate: number, raw: Buffer, channels: number): Promise<void> {
    if (this.rt && sampleRate !== this.rate) this.close();
    if (!this.rt) this.open(sampleRate);
    const pcm = convertChannels(raw, channels, this.channels);
    const buf = this.carry.length ? Buffer.concat([this.carry, pcm]) : pcm;
    const whole = buf.length - (buf.length % this.frameBytes);
    const rt = this.rt!;
    for (let at = 0; at < whole; at += this.frameBytes) rt.write(buf.subarray(at, at + this.frameBytes));
    this.carry = Buffer.from(buf.subarray(whole));
  }

  flush(): void {
    if (!this.rt || !this.carry.length) return;
    const frame = Buffer.alloc(this.frameBytes);
    this.carry.copy(frame);
    this.rt.write(frame);
    this.carry = Buffer.alloc(0);
  }

  cut(): void {
    this.close();
  }

  close(): void {
    this.carry = Buffer.alloc(0);
    if (!this.rt) return;
    try {
      if (this.rt.isStreamOpen()) this.rt.closeStream();
    } catch (err) {
      this.log.warn('关闭 RVC 输出流失败', { err: String(err) });
    }
    this.rt = null;
  }

  private open(sampleRate: number): void {
    this.audify ??= loadAudify();
    const audify = this.audify;
    let rt = new audify.RtAudio(apiOf(audify));
    let devices = rt.getDevices().filter((d) => d.outputChannels > 0);
    let deviceId = rt.getDefaultOutputDevice();
    const frameSize = Math.round((sampleRate * FRAME_MS) / 1000);
    const channelsOf = (): number => Math.min(2, Math.max(1, devices.find((d) => d.id === deviceId)?.outputChannels ?? 2));
    const open = (): number => {
      rt.openStream(
        { deviceId, nChannels: channelsOf(), firstChannel: 0 },
        null,
        audify.RtAudioFormat.RTAUDIO_SINT16,
        sampleRate,
        frameSize,
        STREAM_NAME,
        null,
        null,
      );
      rt.start();
      return channelsOf();
    };
    let channels: number;
    try {
      channels = open();
    } catch {
      try { if (rt.isStreamOpen()) rt.closeStream(); } catch { /* 已断开 */ }
      rt = new audify.RtAudio(apiOf(audify));
      devices = rt.getDevices().filter((d) => d.outputChannels > 0);
      deviceId = rt.getDefaultOutputDevice();
      try {
        channels = open();
      } catch (again) {
        throw new Error(`打不开输出设备：${String(again)}`);
      }
    }
    this.rt = rt;
    this.rate = sampleRate;
    this.channels = channels;
    this.frameBytes = frameSize * 2 * channels;
  }
}

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((done) => setTimeout(done, ms)) : Promise.resolve());

/** 背景读文件 + 控速；代次变了就停，旧循环不会和新歌抢声卡。 */
export class BackgroundSongPlayer implements SongPlayer {
  private generation = 0;
  private fd: number | null = null;
  /** mp3 等转出来的临时 WAV 目录；停播或播完时删。 */
  private tempDir: string | null = null;

  constructor(
    private readonly sink: AudioSink,
    private readonly log: Logger,
    private readonly opts: PlayerOptions = {},
  ) {}

  stop(): void {
    this.generation += 1;
    if (this.fd !== null) {
      try { closeSync(this.fd); } catch { /* 已关闭 */ }
      this.fd = null;
    }
    const temp = this.tempDir;
    this.tempDir = null;
    removeTemp(temp);
    this.sink.cut();
  }

  close(): void {
    this.stop();
    this.sink.close();
  }

  async playFile(path: string): Promise<{ durationSec: number; info: WavInfo }> {
    this.stop();
    const generation = this.generation;
    // 库里的翻唱一般是 mp3：先用 ffmpeg 转成临时 WAV，播完/停播时删掉临时目录。
    let playPath = path;
    let tempDir: string | null = null;
    if (extname(path).toLowerCase() !== '.wav') {
      tempDir = mkdtempSync(join(tmpdir(), 'rvc-play-'));
      playPath = join(tempDir, 'song.wav');
      try {
        await convertToWav(path, playPath, this.opts.ffmpeg ?? 'ffmpeg');
      } catch (err) {
        removeTemp(tempDir);
        throw err;
      }
      if (generation !== this.generation) {
        removeTemp(tempDir);
        throw new Error('播放已取消');
      }
      this.tempDir = tempDir;
    }
    const size = statSync(playPath).size;
    const fd = openSync(playPath, 'r');
    this.fd = fd;
    let info: WavInfo | null = null;
    try {
      const head = Buffer.alloc(Math.min(HEADER_BYTES, size));
      readSync(fd, head, 0, head.length, 0);
      info = parseWav(head);
    } catch (err) {
      this.release(fd);
      removeTemp(tempDir);
      throw err;
    }
    if (!info || info.dataStart > size) {
      this.release(fd);
      removeTemp(tempDir);
      throw new Error('不是合法的 WAV 文件');
    }
    if (info.audioFormat !== 1 || info.bitsPerSample !== 16) {
      this.release(fd);
      removeTemp(tempDir);
      throw new Error('只支持 16-bit PCM WAV');
    }
    if (info.channels !== 1 && info.channels !== 2) {
      this.release(fd);
      removeTemp(tempDir);
      throw new Error(`只支持 1 / 2 声道，这个文件是 ${info.channels} 声道`);
    }
    const dataSize = Math.max(0, Math.min(info.dataSize, size - info.dataStart));
    const loop = this.loop(generation, fd, { ...info, dataSize, durationSec: info.durationSec }, tempDir);
    // 第一块写进输出流（或文件是空的）后才回执，保证「说在放」时真的开始出声。
    const started = await loop.started;
    if (!started) throw new Error('播放已取消');
    void loop.done;
    return { durationSec: info.durationSec, info };
  }

  private release(fd: number): void {
    try { closeSync(fd); } catch { /* 已关闭 */ }
    if (this.fd === fd) this.fd = null;
  }

  private loop(
    generation: number,
    fd: number,
    info: WavInfo,
    tempDir: string | null = null,
  ): { started: Promise<boolean>; done: Promise<void> } {
    let markStarted: (ok: boolean) => void = () => undefined;
    const started = new Promise<boolean>((resolve) => { markStarted = resolve; });
    const bytesPerFrame = info.channels * 2;
    const chunkBytes = Math.max(bytesPerFrame, Math.round(info.sampleRate * CHUNK_SEC) * bytesPerFrame);
    const done = (async () => {
      let pos = info.dataStart;
      let left = info.dataSize;
      let endsAt = 0;
      let first = true;
      try {
        if (left <= 0) {
          this.sink.flush();
          markStarted(true);
          return;
        }
        while (left > 0 && generation === this.generation) {
          const want = Math.min(left, chunkBytes);
          const buf = Buffer.alloc(want);
          const got = readSync(fd, buf, 0, want, pos);
          if (got <= 0) break;
          const pcm = got === want ? buf : buf.subarray(0, got);
          await this.sink.write(info.sampleRate, pcm, info.channels);
          if (first) {
            first = false;
            markStarted(true);
          }
          pos += got;
          left -= got;
          const seconds = got / bytesPerFrame / info.sampleRate;
          endsAt = Math.max(endsAt, Date.now()) + seconds * 1000;
          if (left > 0) await sleep(endsAt - Date.now() - LEAD_MS);
        }
        if (!first) this.sink.flush();
      } catch (err) {
        // 被新点歌打断时 readSync 会因关 fd 报错，这不是故障，不记日志。
        if (generation === this.generation) this.log.warn('RVC 翻唱播放中断', { err: String(err) });
        if (first) markStarted(false);
      } finally {
        this.release(fd);
        // 播完自然结束就删临时 WAV；stop() 抢先删过也没关系。
        if (this.tempDir === tempDir) this.tempDir = null;
        removeTemp(tempDir);
      }
    })();
    return { started, done };
  }
}
