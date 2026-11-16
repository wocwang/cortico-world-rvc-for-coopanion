/**
 * 翻唱库的本机播放：交给外部的 ffplay 子进程，宿主进程里不加载任何原生音频模块。
 *
 * 为什么不再用 audify：Coopanion 的多个 World 跑在同一个 Electron 主进程里，RVC 与
 * GPT-SoVITS 各自带了一份 `audify.node`；第二份被 require 时，N-API 注册同一个
 * environment cleanup hook 会断言失败（`hooks.cc:181 result.second`），整个进程
 * exit 134，桌宠随即重启。播放器改成独立进程后，它自己退出也只影响这一首歌。
 *
 * mp3 等格式仍先用 ffmpeg 转成临时 PCM16 WAV；ffplay 进程起来并过了短暂观察窗口
 * 后才回执。再点歌直接 kill 旧进程，队列里没播的部分丢掉。
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import { parseWav, type WavInfo } from './wav.ts';

const STREAM_NAME = 'cortico-world-rvc';
const HEADER_BYTES = 256 * 1024;
/** ffplay 起来后先看这么久：立即非零退出（坏文件 / 没有声卡）要当场报出来。 */
const START_GRACE_MS = 250;
const STDERR_LIMIT = 4000;

/** 可注入的 spawn，单测用来避免真的调起播放器。 */
export type SpawnLike = (
  command: string,
  args: string[],
  options: { windowsHide?: boolean; stdio?: ['ignore', 'ignore', 'pipe'] },
) => ChildProcess;

export interface SongPlayer {
  /** 停下当前歌曲（关掉播放器进程）。 */
  stop(): void;
  /**
   * 从头播放一个音频；播放器进程确认启动后返回。
   * `onEnded` 在自然播完、被 stop() 或 close() 停掉时各调用一次，用来更新「播放中」状态。
   */
  playFile(
    path: string,
    hooks?: { onEnded?: () => void },
  ): Promise<{ durationSec: number; info: WavInfo }>;
  /** 停播并释放资源。 */
  close(): void;
}

export interface PlayerOptions {
  /** ffmpeg 可执行文件；默认走 PATH（worker 解 mp3 用的也是它）。 */
  ffmpeg?: string;
  /** ffplay 可执行文件；默认走 PATH，与 ffmpeg 通常在同一目录。 */
  ffplay?: string;
  /** 单测注入；默认 node:child_process.spawn。 */
  spawn?: SpawnLike;
  /** 启动观察窗口；默认 250 ms。 */
  startGraceMs?: number;
}

/** 把浏览器能播、ffplay 播不了的格式转成临时 WAV；用完删目录。 */
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
          ? `ffmpeg 不可用，无法把 ${extname(input) || '这个格式'} 转成 WAV；请安装 ffmpeg 并加入 PATH（见 README「ffmpeg」）`
          : `ffmpeg 转换失败：${tail}`));
      },
    );
  });
}

function removeTemp(dir: string | null, retries = 1): void {
  if (!dir) return;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 还在播或已删 */ }
  // Windows 上播放器可能还捏着文件句柄；下一轮再试一次，别留垃圾目录。
  if (retries > 0 && existsSync(dir)) {
    const timer = setTimeout(() => removeTemp(dir, retries - 1), 1_000);
    timer.unref?.();
  }
}

const tailOf = (text: string): string =>
  String(text || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0, 400);

/** ffplay 子进程播放器：一个进程一首歌，stop() 直接杀掉。 */
export class FfplayPlayer implements SongPlayer {
  private generation = 0;
  private child: ChildProcess | null = null;
  /** mp3 等转出来的临时 WAV 目录；停播或播完时删。 */
  private tempDir: string | null = null;
  /** 当前这一首结束时通知 World；自然播完、stop()/close() 都会调用一次。 */
  private endHandler: (() => void) | null = null;

  constructor(
    private readonly log: Logger,
    private readonly opts: PlayerOptions = {},
  ) {}

  stop(): void {
    this.generation += 1;
    const child = this.child;
    this.child = null;
    if (child) {
      try { child.kill(); } catch { /* 已经退出 */ }
    }
    const temp = this.tempDir;
    this.tempDir = null;
    removeTemp(temp);
    const end = this.endHandler;
    this.endHandler = null;
    end?.();
  }

  close(): void {
    this.stop();
  }

  async playFile(
    path: string,
    hooks: { onEnded?: () => void } = {},
  ): Promise<{ durationSec: number; info: WavInfo }> {
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
    }
    const size = statSync(playPath).size;
    const fd = openSync(playPath, 'r');
    let info: WavInfo | null = null;
    try {
      const head = Buffer.alloc(Math.min(HEADER_BYTES, size));
      readSync(fd, head, 0, head.length, 0);
      info = parseWav(head);
    } catch (err) {
      closeSync(fd);
      removeTemp(tempDir);
      throw err;
    }
    closeSync(fd);
    if (!info || info.dataStart > size) {
      removeTemp(tempDir);
      throw new Error('不是合法的 WAV 文件');
    }
    if (info.audioFormat !== 1 || info.bitsPerSample !== 16) {
      removeTemp(tempDir);
      throw new Error('只支持 16-bit PCM WAV');
    }
    if (info.channels !== 1 && info.channels !== 2) {
      removeTemp(tempDir);
      throw new Error(`只支持 1 / 2 声道，这个文件是 ${info.channels} 声道`);
    }

    const stderr = { text: '' };
    let child: ChildProcess;
    try {
      child = await this.start(playPath, stderr);
    } catch (err) {
      removeTemp(tempDir);
      throw err;
    }
    if (generation !== this.generation) {
      try { child.kill(); } catch { /* 已经退出 */ }
      removeTemp(tempDir);
      throw new Error('播放已取消');
    }
    this.child = child;
    this.tempDir = tempDir;
    this.endHandler = hooks.onEnded ?? null;
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      const temp = this.tempDir;
      this.tempDir = null;
      removeTemp(temp);
      if (code !== null && code !== 0) {
        this.log.warn('RVC 翻唱播放中断', { code, signal, err: tailOf(stderr.text) });
      }
      const end = this.endHandler;
      this.endHandler = null;
      end?.();
    });
    return { durationSec: info.durationSec, info };
  }

  /** 调起 ffplay 并等它确认启动；坏文件 / 没声卡会在观察窗口内直接报错。 */
  private start(file: string, stderr: { text: string }): Promise<ChildProcess> {
    const spawnFn: SpawnLike = this.opts.spawn ?? (spawn as SpawnLike);
    const bin = this.opts.ffplay ?? 'ffplay';
    const child = spawnFn(
      bin,
      ['-hide_banner', '-loglevel', 'error', '-nodisp', '-autoexit', '-i', file],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.text.length < STDERR_LIMIT) stderr.text += String(chunk);
    });
    child.on('error', (err: Error) => {
      // 启动阶段的错误由下面的 Promise 回执；运行期再出错只记日志，别往外抛。
      if (this.child === child) this.log.warn('RVC 播放器出错', { err: err.message });
    });
    return new Promise<ChildProcess>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(child);
      };
      child.once('error', (err: NodeJS.ErrnoException) => {
        const missing = err.code === 'ENOENT';
        finish(new Error(missing
          ? `ffplay 不可用（找不到 ${bin}），无法播放；请安装完整版 ffmpeg（含 ffplay）并加入 PATH（见 README「ffmpeg」）`
          : `启动 ${STREAM_NAME} 播放器失败：${err.message}`));
      });
      child.once('spawn', () => {
        const timer = setTimeout(() => {
          if (settled) return;
          const code = child.exitCode;
          if (code !== null && code !== 0) {
            finish(new Error(`ffplay 启动后立即退出（code ${code}）：${tailOf(stderr.text) || '没有输出'}`));
            return;
          }
          finish();
        }, Math.max(0, this.opts.startGraceMs ?? START_GRACE_MS));
        timer.unref?.();
      });
    });
  }
}

/** 兼容旧名字：World 里一直叫 BackgroundSongPlayer。 */
export const BackgroundSongPlayer = FfplayPlayer;
