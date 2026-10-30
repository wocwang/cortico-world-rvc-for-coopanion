import { afterEach, describe, expect, it } from 'vitest';
import { RvcError } from '../src/engine.ts';
import {
  parseMultipart, readConvertJob, RvcHttpError, startConvertServer,
  type ConvertDeps, type ConvertJob, type ConvertServerHandle,
} from '../src/server.ts';

const log = (() => {
  const l = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, emit: () => {}, child: () => l };
  return l;
})() as never;

/** 一段 0.01 秒的静音 WAV 头 + 数据，够当作上传内容。 */
const WAV = Buffer.concat([
  Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEfmt '),
  Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x80, 0x3e, 0, 0, 0, 0x7d, 0, 0, 2, 0, 16, 0]),
  Buffer.from('data'), Buffer.from([0, 0, 0, 0]),
]);

const form = (fields: Record<string, string> = {}, opts: { file?: boolean; filename?: string } = {}): FormData => {
  const body = new FormData();
  if (opts.file !== false) body.set('file', new Blob([WAV], { type: 'audio/wav' }), opts.filename ?? 'in.wav');
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return body;
};

let handle: ConvertServerHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

interface Harness {
  base: string;
  jobs: ConvertJob[];
  deps: ConvertDeps;
  overlap: boolean[];
}

async function boot(opts: {
  token?: string;
  ready?: boolean;
  hold?: number;
  queueLimit?: number;
  fail?: RvcError;
  saved?: string;
  uvr5?: boolean;
} = {}): Promise<Harness> {
  const jobs: ConvertJob[] = [];
  const overlap: boolean[] = [];
  let busy = false;
  const deps: ConvertDeps = {
    log,
    ready: () => opts.ready !== false,
    stateText: () => 'starting',
    health: () => ({ ready: opts.ready !== false, device: 'cuda:0', model: 'daifeiyu' }),
    uvr5: () => opts.uvr5 === true,
    convert: async (job) => {
      overlap.push(busy);
      busy = true;
      jobs.push(job);
      try {
        if (opts.hold) await new Promise((r) => setTimeout(r, opts.hold));
        if (opts.fail) throw opts.fail;
        return { audio: Buffer.from('converted'), savedPath: opts.saved };
      } finally {
        busy = false;
      }
    },
  };
  handle = await startConvertServer({ port: 0, token: opts.token, deps, queueLimit: opts.queueLimit });
  return { base: `http://127.0.0.1:${handle.port}`, jobs, deps, overlap };
}

const post = (base: string, body: FormData, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}/convert`, { method: 'POST', body, headers });

describe('RVC 本机接口', () => {
  it('GET /health 给出 ok/ready/device/model/queue', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ready: true, device: 'cuda:0', model: 'daifeiyu', queue: 0 });
  });

  it('POST /convert 回音频字节，并带上耗时头', async () => {
    const { base, jobs } = await boot();
    const res = await post(base, form({ voice: 'daifeiyu', pitch: '2', indexRate: '0.5', protect: '0.2' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/wav');
    expect(Number(res.headers.get('x-rvc-ms'))).toBeGreaterThanOrEqual(0);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('converted');
    expect(jobs[0]).toMatchObject({ voice: 'daifeiyu', pitch: 2, indexRate: 0.5, protect: 0.2, format: 'wav', save: false });
    expect(jobs[0]!.file.equals(WAV)).toBe(true);
  });

  it('save=1 时把落盘路径放进 X-Rvc-Saved', async () => {
    const { base } = await boot({ saved: 'D:\\data\\out\\rvc-1.wav' });
    const res = await post(base, form({ save: '1' }));
    expect(res.status).toBe(200);
    expect(decodeURIComponent(res.headers.get('x-rvc-saved') ?? '')).toBe('D:\\data\\out\\rvc-1.wav');
  });

  it('并发 1：两条同时进来也只跑一条', async () => {
    const { base, overlap } = await boot({ hold: 80 });
    const [a, b] = await Promise.all([post(base, form()), post(base, form())]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(overlap).toEqual([false, false]);
  });

  it('队列到上限立即 503', async () => {
    const { base, overlap } = await boot({ hold: 250, queueLimit: 2 });
    const results = await Promise.all([post(base, form()), post(base, form()), post(base, form())]);
    const codes = results.map((r) => r.status).sort();
    expect(codes).toContain(503);
    expect(codes.filter((c) => c === 200).length).toBeGreaterThanOrEqual(1);
    expect(overlap.every((busy) => busy === false)).toBe(true);
  });

  it('配了 token 就要 Bearer 或 ?token=', async () => {
    const { base } = await boot({ token: 's3cret' });
    expect((await fetch(`${base}/health`)).status).toBe(401);
    expect((await fetch(`${base}/health`, { headers: { authorization: 'Bearer s3cret' } })).status).toBe(200);
    expect((await fetch(`${base}/health?token=s3cret`)).status).toBe(200);
    expect((await post(base, form(), { authorization: 'Bearer nope' })).status).toBe(401);
    expect((await post(base, form(), { authorization: 'Bearer s3cret' })).status).toBe(200);
  });

  it('参数越界与缺文件都是 400', async () => {
    const { base } = await boot();
    const cases: Array<[FormData, string]> = [
      [form({ pitch: '25' }), 'pitch 越界'],
      [form({ pitch: '1.5' }), 'pitch 非整数'],
      [form({ indexRate: '1.2' }), 'indexRate 越界'],
      [form({ protect: '0.7' }), 'protect 越界'],
      [form({ format: 'flac' }), 'format 不支持'],
      [form({ save: 'yes' }), 'save 非法'],
      [form({ separator: 'uvr5' }), 'uvr5 不可用'],
      [form({}, { file: false }), '缺文件'],
      [form({}, { filename: 'in.txt' }), '扩展名不支持'],
    ];
    for (const [body, why] of cases) {
      const res = await post(base, body);
      expect(res.status, why).toBe(400);
    }
  });

  it('separator=uvr5：模型没装 400，装了就走同一套转换', async () => {
    const missing = await boot({ uvr5: false });
    const a = await post(missing.base, form({ separator: 'uvr5' }));
    expect(a.status).toBe(400);
    expect(((await a.json()) as { error: string }).error).toContain('人声分离模型');
    await handle?.close();

    const present = await boot({ uvr5: true });
    const b = await post(present.base, form({ separator: 'uvr5' }));
    expect(b.status).toBe(200);
    expect(present.jobs[0]).toMatchObject({ separator: 'uvr5' });
  });

  it('错误映射：未就绪 409、解码失败 400、推理失败 502', async () => {
    const notReady = await boot({ ready: false });
    expect((await post(notReady.base, form())).status).toBe(409);
    await handle?.close();

    const decode = await boot({ fail: new RvcError('decode', '解码失败') });
    expect((await post(decode.base, form())).status).toBe(400);
    await handle?.close();

    const infer = await boot({ fail: new RvcError('infer', '推理炸了') });
    const res = await post(infer.base, form());
    expect(res.status).toBe(502);
    expect((await res.json()) as { error: string }).toEqual({ error: '推理炸了' });
  });

  it('未知路由 404', async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe('multipart 与字段校验', () => {
  it('解析文本字段与二进制文件', () => {
    const boundary = 'xYz123';
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="voice"\r\n\r\ndaifeiyu\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`
      + `\x00\x01\r\n--${boundary}--\r\n`,
      'binary',
    );
    const parsed = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
    expect(parsed.fields.voice).toBe('daifeiyu');
    expect(parsed.file?.filename).toBe('a.wav');
    expect([...(parsed.file?.data ?? [])]).toEqual([0, 1]);
  });

  it('没有 boundary 就 400', () => {
    expect(() => parseMultipart(Buffer.from('x'), 'multipart/form-data')).toThrow(RvcHttpError);
  });

  it('默认值：pitch 0、indexRate 0.3、protect 0.33、wav、不落盘', () => {
    const job = readConvertJob({
      fields: {},
      file: { filename: 'a.wav', data: WAV },
    });
    expect(job).toMatchObject({ pitch: 0, indexRate: 0.3, protect: 0.33, format: 'wav', save: false, voice: '' });
  });
});
