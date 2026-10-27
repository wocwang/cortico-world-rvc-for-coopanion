/**
 * 给其他插件与面板用的本机 RVC 接口：`GET /health`、`POST /convert`（multipart/form-data）。
 *
 * 只监听 127.0.0.1；配了 token 时要求 `Authorization: Bearer` 或 `?token=`。
 * 单 GPU 串行：并发 1，排队上限默认 4，超出立即 503（调用方按失败处理，不要等）。
 *
 * `POST /convert` 的错误码（spec §6）：400 参数/解码失败、409 模型未就绪、
 * 502 推理失败、503 队列满；token 不对为 401。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from 'cortico/core/types.ts';
import { PITCH_MAX, PITCH_MIN, PROTECT_MAX } from './config.ts';

/** 单次请求体上限：一条几分钟的音频足够，别让内存被占满。 */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** 排队上限（含正在跑的那条）。 */
export const DEFAULT_QUEUE_LIMIT = 4;

export interface ConvertJob {
  /** 上传的原始音频。 */
  file: Buffer;
  filename: string;
  /** 空为插件的默认音色。 */
  voice: string;
  pitch: number;
  indexRate: number;
  protect: number;
  format: 'wav' | 'mp3';
  /** 落盘到插件数据目录，另外返回路径。 */
  save: boolean;
}

export interface ConvertOutcome {
  audio: Buffer;
  /** `save=1` 时写出的文件路径。 */
  savedPath?: string;
}

export interface ConvertDeps {
  /** 引擎此刻能不能接活。 */
  ready(): boolean;
  /** 不能接活时的说明，用作 409 文案。 */
  stateText(): string;
  /** 引擎状态：设备、当前音色。 */
  health(): { ready: boolean; device: string | null; model: string | null };
  /** 真正做转换；失败抛 `RvcError`。 */
  convert(job: ConvertJob): Promise<ConvertOutcome>;
  log: Logger;
}

export interface ConvertServerHandle {
  port: number;
  close: () => Promise<void>;
}

/** 带 HTTP 状态码的接口错误，handler 里统一转成 JSON。 */
export class RvcHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'RvcHttpError';
  }
}

interface MultipartFile {
  filename: string;
  data: Buffer;
}

export interface MultipartBody {
  fields: Record<string, string>;
  file: MultipartFile | null;
}

const AUDIO_EXTENSIONS = ['.wav', '.flac', '.mp3', '.ogg', '.m4a'];

/**
 * 极简 multipart 解析：只认本轮接口用到的形状（一个 `file` + 若干文本字段）。
 * 分隔符按 `\r\n--<boundary>` 找，二进制内容原样保留。
 */
export function parseMultipart(body: Buffer, contentType: string): MultipartBody {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  const boundary = (match?.[1] ?? match?.[2] ?? '').trim();
  if (!boundary) throw new RvcHttpError(400, 'content-type 不是 multipart/form-data');
  const delimiter = Buffer.from(`--${boundary}`);
  const crlfDelimiter = Buffer.from(`\r\n--${boundary}`);
  const fields: Record<string, string> = {};
  let file: MultipartFile | null = null;
  let pos = body.indexOf(delimiter);
  if (pos < 0) throw new RvcHttpError(400, 'multipart 内容为空');
  while (pos >= 0) {
    const after = pos + delimiter.length;
    if (body[after] === 0x2d && body[after + 1] === 0x2d) break; // 收尾的 `--`
    const start = body[after] === 0x0d && body[after + 1] === 0x0a ? after + 2 : after;
    const next = body.indexOf(crlfDelimiter, start);
    const end = next >= 0 ? next : body.length;
    const headerEnd = body.indexOf('\r\n\r\n', start);
    if (headerEnd < 0 || headerEnd > end) throw new RvcHttpError(400, 'multipart 分片格式不对');
    const headers = body.subarray(start, headerEnd).toString('utf8');
    const data = body.subarray(headerEnd + 4, end);
    const name = /name="([^"]*)"/i.exec(headers)?.[1] ?? '';
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
    if (!name) throw new RvcHttpError(400, 'multipart 分片没有 name');
    if (filename !== undefined) {
      if (name === 'file') file = { filename, data: Buffer.from(data) };
    } else {
      fields[name] = data.toString('utf8');
    }
    pos = next >= 0 ? next + 2 : -1;
  }
  return { fields, file };
}

const num = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new RvcHttpError(400, `参数不是数字：${raw}`);
  return value;
};

/** 字段校验：范围按 spec §6，越界一律 400。 */
export function readConvertJob(multipart: MultipartBody): ConvertJob {
  const { fields, file } = multipart;
  if (!file || !file.data.length) throw new RvcHttpError(400, '缺少音频文件 file');
  const ext = /\.[^./\\]+$/.exec(file.filename.toLowerCase())?.[0] ?? '';
  if (!AUDIO_EXTENSIONS.includes(ext)) {
    throw new RvcHttpError(400, `不支持的音频扩展名：${ext || '(无)'}；可用 ${AUDIO_EXTENSIONS.join(' ')}`);
  }
  const pitch = num(fields.pitch, 0);
  if (!Number.isInteger(pitch) || pitch < PITCH_MIN || pitch > PITCH_MAX) {
    throw new RvcHttpError(400, `pitch 必须是 ${PITCH_MIN}..${PITCH_MAX} 的整数`);
  }
  const indexRate = num(fields.indexRate, 0.3);
  if (indexRate < 0 || indexRate > 1) throw new RvcHttpError(400, 'indexRate 必须在 0..1');
  const protect = num(fields.protect, 0.33);
  if (protect < 0 || protect > PROTECT_MAX) throw new RvcHttpError(400, `protect 必须在 0..${PROTECT_MAX}`);
  const separator = (fields.separator ?? 'off').trim() || 'off';
  if (separator !== 'off' && separator !== 'uvr5') throw new RvcHttpError(400, `未知的 separator：${separator}`);
  if (separator === 'uvr5') throw new RvcHttpError(400, 'separator=uvr5 暂不可用（缺 tools/uvr5）');
  const format = (fields.format ?? 'wav').trim() || 'wav';
  if (format !== 'wav' && format !== 'mp3') throw new RvcHttpError(400, `未知的 format：${format}`);
  const saveRaw = (fields.save ?? '0').trim() || '0';
  if (saveRaw !== '0' && saveRaw !== '1') throw new RvcHttpError(400, 'save 只能是 0 或 1');
  return {
    file: file.data,
    filename: file.filename || `input${ext}`,
    voice: (fields.voice ?? '').trim(),
    pitch,
    indexRate,
    protect,
    format,
    save: saveRaw === '1',
  };
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new RvcHttpError(400, `请求体超过 ${Math.round(limit / 1024 / 1024)} MB`));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

/** 起接口；`port` 为 0 时由系统分配。 */
export function startConvertServer(opts: {
  port: number;
  token?: string;
  deps: ConvertDeps;
  queueLimit?: number;
}): Promise<ConvertServerHandle> {
  const { deps } = opts;
  const token = opts.token?.trim() ?? '';
  const limit = opts.queueLimit ?? DEFAULT_QUEUE_LIMIT;

  // 串行队列：并发 1；到上限直接拒绝，不排队等。
  let active = 0;
  const waiting: Array<() => void> = [];
  const depth = (): number => active + waiting.length;
  const acquire = async (): Promise<void> => {
    if (depth() >= limit) throw new RvcHttpError(503, 'RVC 队列已满，稍后再试');
    if (active === 0) { active = 1; return; }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active = 0;
  };

  const send = (res: ServerResponse, code: number, body: Buffer | string, type: string, headers: Record<string, string> = {}): void => {
    res.writeHead(code, { 'content-type': type, 'content-length': Buffer.byteLength(body), ...headers });
    res.end(body);
  };
  const json = (res: ServerResponse, code: number, obj: unknown): void =>
    send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');

  const authorized = (req: IncomingMessage, url: URL): boolean => {
    if (!token) return true;
    if ((req.headers.authorization ?? '') === `Bearer ${token}`) return true;
    return url.searchParams.get('token') === token;
  };

  const convert = async (res: ServerResponse, req: IncomingMessage): Promise<void> => {
    const raw = await readBody(req, MAX_BODY_BYTES);
    const job = readConvertJob(parseMultipart(raw, req.headers['content-type'] ?? ''));
    if (!deps.ready()) throw new RvcHttpError(409, `模型未就绪：${deps.stateText()}`);
    await acquire();
    const at = Date.now();
    try {
      const out = await deps.convert(job);
      const type = job.format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
      const headers: Record<string, string> = { 'x-rvc-ms': String(Date.now() - at) };
      if (out.savedPath) headers['x-rvc-saved'] = encodeURIComponent(out.savedPath);
      deps.log.info('RVC 变声完', { voice: job.voice, ms: Date.now() - at, bytes: out.audio.length, format: job.format });
      send(res, 200, out.audio, type, headers);
    } finally {
      release();
    }
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!authorized(req, url)) { json(res, 401, { error: 'bad token' }); return; }
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
      const health = deps.health();
      json(res, 200, { ok: true, ready: health.ready, device: health.device, model: health.model, queue: depth() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/convert') {
      void convert(res, req).catch((err: unknown) => {
        if (res.headersSent) { res.destroy(); return; }
        const status = err instanceof RvcHttpError ? err.status : isUnavailable(err) ? 409 : isBadRequest(err) ? 400 : 502;
        const why = err instanceof Error ? err.message : String(err);
        if (status >= 500) deps.log.warn('RVC 接口转换失败', { status, err: why });
        json(res, status, { error: why });
      });
      return;
    }
    json(res, 404, { error: `no such route: ${req.method} ${url.pathname}` });
  };

  return new Promise((resolve, reject) => {
    const server: Server = createServer(handler);
    server.on('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : opts.port;
      deps.log.info('RVC 接口已就绪', { port, auth: !!token, queueLimit: limit });
      resolve({
        port,
        close: () => new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections();
        }),
      });
    });
  });
}

const isBadRequest = (err: unknown): boolean => {
  const kind = err instanceof Error ? (err as { kind?: unknown }).kind : undefined;
  return kind === 'decode' || kind === 'param';
};
const isUnavailable = (err: unknown): boolean => err instanceof Error && (err as { kind?: unknown }).kind === 'unavailable';
