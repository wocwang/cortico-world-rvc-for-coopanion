/**
 * B 站：搜索 → 相关度打分 → 取音频流 → 下载。
 *
 * 移植自 `FXYXL/cortico-world-fish-sing` 的 `src/bili.ts`，按本仓库的需要补了
 * 置信度判断、候选列表、412/失效重试与「换下一条候选」。原实现是 MIT 许可：
 *
 * MIT License
 * Copyright (c) 2026 大肥鱼
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * 这套接口实测（2026-10-27）：搜索**不需要 wbi 签名**，带 `buvid3` cookie + 普通 UA
 * 就能 `code:0`；`x/player/playurl?...&fnval=16` 的 `dash.audio[*].baseUrl` 直接能下载
 * （内容一般是 audio/mp4）。不需要登录。
 */
import { writeFile } from 'node:fs/promises';
import {
  isRendition, isSuffixMarker, norm, renditionKinds, songMatchLevel, splitQuery, stripTags, tailAfter,
  type SongMatchLevel,
} from './match.ts';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

export interface SearchHit {
  bvid: string;
  title: string;
  author: string;
  durationSec: number;
  play: number;
  score?: number;
  /** 标题与歌名的匹配级别：partial 只表示「标题里包含这个词」，不是同一首歌。 */
  matchLevel?: SongMatchLevel;
  /** 标题里的歌手 / 团体名（从歌名之后的尾巴里认）；认不出就是空串。 */
  artist?: string;
}

/** 标题里出现就重罚的词：教程、伴奏、合集、直播回放…… */
const BAD_TITLE =
  /教程|教学|谱|翻弹|指弹|钢琴|吉他|架子鼓|纯音乐|伴奏|消音|卡拉ok|ktv|合集|串烧|一小时|10小时|循环|直播|录播|reaction|解说|舞蹈|手书|试听|片段|切片|音频预览/;
const GOOD_TITLE = /官方|mv|原唱|原版|纯享|收藏级|高音质|无损|完整版|歌词|无损音质|hi-?res/i;
/** 标题党：自称「这才是原版」的搬运，不能靠 GOOD_TITLE 加分压过真目标。 */
const CLICKBAIT_TITLE = /这才是|不是原版|伪原版|盗版|搬运|补档|全网首发|震惊/;

export type BiliReason = 'ok' | 'no-result' | 'weak-match' | 'partial' | 'version' | 'ambiguous';

export interface BiliPick {
  /** 是否足够确定：不确定就把候选交给用户选，别硬跑几分钟。 */
  confident: boolean;
  reason: BiliReason;
  /** 按相关度倒序的候选（最多 `limit` 条）。 */
  candidates: SearchHit[];
}

export interface BiliAudio {
  url: string;
  mime: string;
  title: string;
  author: string;
  durationSec: number;
}

export interface DownloadedAudio extends BiliAudio {
  bytes: number;
}

/** 真实实现与测试替身共用的一套接口。 */
export interface BiliClient {
  search(keyword: string, limit?: number): Promise<SearchHit[]>;
  /** 下载到 `dest`；内部会重取 playurl、对 412/失效做重试。 */
  fetch(bvid: string, dest: string, maxBytes: number): Promise<DownloadedAudio>;
}

export function isBvid(text: string): boolean {
  return /^BV[0-9A-Za-z]{10}$/.test(text.trim());
}

/** 从任意文本里抠 BV 号（支持整条链接）。 */
export function extractBvid(text: string): string | null {
  const m = /(BV[0-9A-Za-z]{10})/.exec(text || '');
  return m ? m[1] : null;
}

function durationToSec(text: string): number {
  const parts = String(text || '').split(':').map((x) => Number(x) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

/** 视频标题里与曲名无关的制作 / 画质 / 宣传词；保留翻唱、现场、伴奏这类版本信息。 */
const TITLE_NOISE =
  /(?:百万录音棚|顶级录音棚|专业录音棚|录音棚|官方版|官方|动态歌词|歌词版|完整版|纯享|收藏级|超清画质|超清|高清|画质|音质|中文字幕|双语字幕|字幕|附歌词|带歌词|4k修复|ai修复|修复版|重制版|母带|正版|无损音质|无损|高音质|60帧|120帧)|\b(?:4k|8k|1080p?|720p?|2160p?|hdr|hi-?res|mv|music\s*video|60fps|120fps)\b/gi;

/**
 * 把 B 站视频标题洗成可当曲名 / 入库标题的名字：
 * 去掉【】（）里的画质与宣传词、书名号、话题标签和常见的制作词，保留歌名、歌手与版本。
 */
export function songTitleFromBili(title: string): string {
  let text = stripTags(title)
    .replace(/[【\[（(]/g, ' ')
    .replace(/[】\]）)]/g, ' ')
    .replace(/[《》「」『』]/g, '')
    .replace(/#[^\s#]+/g, ' ')
    .replace(TITLE_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  text = text.replace(/^[\s\-–—·|｜:：,，、_]+|[\s\-–—·|｜:：,，、_]+$/g, '').trim();
  return text.replace(/(?:\s*[-–—·|｜:：,，、_]\s*){2,}/g, ' ').replace(/\s+/g, ' ').trim();
}

async function jsonGet<T>(url: string, extra: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', ...extra },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export type SearchOrder = 'default' | 'click' | 'pubdate';

/** B 站的排序参数：默认综合；找冷门女声翻唱时「按播放」往往比综合靠谱。 */
const ORDER_PARAM: Record<SearchOrder, string> = {
  default: 'totalrank',
  click: 'click',
  pubdate: 'pubdate',
};

/** `buvid3` 进程内缓存 30 分钟：搜索接口带上它风控轻一些。 */
let buvidCache: { value: string; at: number } | null = null;

async function buvid3(): Promise<string> {
  if (buvidCache && Date.now() - buvidCache.at < 30 * 60_000) return buvidCache.value;
  try {
    const spi = await jsonGet<{ data?: { b_3?: string } }>('https://api.bilibili.com/x/frontend/finger/spi');
    const value = spi?.data?.b_3 ?? '';
    if (value) buvidCache = { value, at: Date.now() };
    return value;
  } catch {
    // 拿不到就裸搜，风控会更凶，但不是硬失败。
    return '';
  }
}

export async function searchBili(
  keyword: string,
  limit = 20,
  order: SearchOrder = 'default',
): Promise<SearchHit[]> {
  const want = keyword.trim();
  if (!want) return [];
  const buvid = await buvid3();
  const ord = ORDER_PARAM[order] ?? ORDER_PARAM.default;
  const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&page=1&order=${ord}&keyword=${encodeURIComponent(want)}`;
  const data = await jsonGet<{ code: number; message?: string; data?: { result?: unknown[] } }>(
    url,
    buvid ? { Cookie: `buvid3=${buvid}` } : {},
  );
  if (data.code !== 0) throw new Error(`B 站搜索返回 code=${data.code} ${data.message ?? ''}`.trim());
  const rows = (data.data?.result ?? []) as Record<string, unknown>[];
  return rows
    .filter((r) => typeof r.bvid === 'string')
    .slice(0, limit)
    .map((r) => ({
      bvid: String(r.bvid),
      title: stripTags(String(r.title ?? '')),
      author: String((r.author as string) ?? ''),
      durationSec: durationToSec(String(r.duration ?? '')),
      play: Number(r.play ?? 0) || 0,
    }));
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 标题 + UP 主名：附加片段可以是歌名后的人名 / 团体名，所以作者也参与匹配。 */
function corpusOf(hit: SearchHit): string {
  return `${norm(hit.title)}\u0000${norm(hit.author)}`;
}

/** 歌手名里不该出现的词：画质、音质、版本、演绎标记。 */
const ARTIST_NOISE =
  /画质|音质|高清|超清|无损|完整|纯享|收藏|字幕|修复|母带|正版|原版|官方|录音棚|动态|歌词|hi-?res|4k|8k|1080p?|720p?|60帧|120帧|original|mix|remix|instrumental|inst|karaoke|cover|live|acoustic|feat|ft|mv|demo|ver/i;

/**
 * 从标题里猜歌手：歌名之后第一个像人名的片段（2-8 个汉字，或单个首字母大写的拉丁词）。
 * 用来在「同名不同歌手」时让用户靠歌手区分；认不出就是空串，绝不用 UP 主名冒充。
 */
export function artistOf(title: string, base: string, query = ''): string {
  const tail = tailAfter(title, base);
  if (!tail) return '';
  const queryPlain = norm(query);
  // 引号里多半是歌词 / 专辑名，不是歌手，整段丢掉。
  const plainTail = tail.replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|《[^》]*》/gu, ' ');
  const parts = plainTail.split(/[^\p{L}\p{N}]+/u).filter((part) => part.length > 0);
  for (const part of parts) {
    const plain = norm(part);
    if (!plain || plain.length < 2 || isSuffixMarker(part) || ARTIST_NOISE.test(part)) continue;
    // 查询本身的词不算歌手：查「Always Remember Us This Way」时尾巴里的 Remember 是歌名。
    if (queryPlain.includes(plain)) continue;
    if (/^[\u3400-\u9fff]{2,8}$/.test(plain)) return part;
    if (/^[A-Z][A-Za-z0-9]{2,14}$/.test(part)) return part;
  }
  return '';
}

/**
 * 相关性打分。为什么需要：只看第一条经常挑到教程、合集、伴奏、甚至不是那首歌的翻弹。
 *
 * 搜索结果本身是 B 站搜索接口的原始顺序（综合排序），这里再重排；原始名次只当
 * 很轻的同分决胜。查询里的附加片段（歌名之后的任何词，如「xxx版」「某某翻唱」
 * 「歌手名」「团体名」）不依赖预置词表：命中 +10、缺失 -14，标题里「不是 xxx」
 * 这类否定直接重罚；完整关键词短语再 +12。播放量仍封顶 4，避免大 UP 的无关
 * 视频靠粉数压过准确度。
 */
const LEVEL_RANK: Record<SongMatchLevel, number> = { exact: 3, suffix: 2, partial: 1, none: 0 };

/**
 * 歌名级匹配取「对歌名」和「对整条查询」中更好的那个：整名查询（Remember me）也要算同名。
 * 歌名部分也一起返回：猜歌手时要用真正命中的那一段，否则「Always Remember Us This Way」
 * 会从歌名后面的 Remember 里猜出个假歌手。
 */
function matchOf(title: string, base: string, full: string): { level: SongMatchLevel; name: string } {
  const levelBase = songMatchLevel(title, base);
  const levelWhole = full && full !== base ? songMatchLevel(title, full) : 'none';
  const better = LEVEL_RANK[levelWhole] > LEVEL_RANK[levelBase];
  const level = better ? levelWhole : levelBase;
  const baseFailed = levelBase === 'partial' || levelBase === 'none';
  const name = baseFailed && (levelWhole === 'exact' || levelWhole === 'suffix') ? full : base;
  return { level, name };
}

/** 歌名级命中才有歌手；只是包含某个词的行不要显示假歌手。 */
function songLevel(level: SongMatchLevel): boolean {
  return level === 'exact' || level === 'suffix';
}

export function rankHits(hits: SearchHit[], keyword: string, excludeWords = ''): SearchHit[] {
  const { tokens, qualifiers, full: fullPhrase, suffixIntent, base } = splitQuery(keyword);
  const extraBad = excludeWords
    .split(/[,，、]+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0);
  return hits
    .map((hit, index) => {
      const low = hit.title.toLowerCase();
      const plain = norm(hit.title);
      const author = norm(hit.author);
      const corpus = corpusOf(hit);
      const match = matchOf(hit.title, base, fullPhrase);
      const level = match.level;
      let score = 0;
      let hitCount = 0;
      for (const t of tokens) {
        if (corpus.includes(t)) hitCount += 1;
      }
      score += hitCount * 8 - (tokens.length - hitCount) * 10;
      // 整名相同才算短语命中；「标题里包含这个词」是另一首歌，反而要扣分。
      if (fullPhrase && (level === 'exact' || level === 'suffix')
        && (plain.includes(fullPhrase) || author.includes(fullPhrase))) score += 12;
      if (level === 'partial') score -= 6;
      if (qualifiers.length) {
        const have = qualifiers.filter((t) => corpus.includes(t)).length;
        score += have * 10 - (qualifiers.length - have) * 14;
        for (const t of qualifiers) {
          if (new RegExp(`(?:不是|并非|非|没有|无)${escapeRe(t)}`).test(plain)) score -= 30;
        }
      }
      if (BAD_TITLE.test(low)) score -= 20;
      if (CLICKBAIT_TITLE.test(low)) score -= 8;
      // 非版本查询才把「现场 / 翻唱」当减分项；用户点名要某个版本时不该反过来扣它。
      if (!suffixIntent && isRendition(low) && !GOOD_TITLE.test(low)) score -= 6;
      if (GOOD_TITLE.test(low)) score += 2;
      for (const w of extraBad) if (low.includes(w)) score -= 10;
      score += Math.min(4, (hit.play || 0) / 500_000);
      // 原始名次只做很轻的决胜，避免完全无视 B 站的相关度。
      score += Math.max(0, 1 - index * 0.05);
      if (hit.durationSec >= 90 && hit.durationSec <= 600) score += 2;
      const artist = songLevel(level) ? artistOf(hit.title, match.name, fullPhrase || base) : '';
      return { ...hit, score: Math.round(score * 10) / 10, matchLevel: level, artist };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/**
 * 选歌：先看有没有「标题/作者含全部关键词」的命中；查询带附加片段时，只把带该片段的
 * 候选放进首选。不确定时 `confident=false`，把候选交给用户；不在这里硬挑。
 */
export function pickCandidates(hits: SearchHit[], keyword: string, limit = 6): BiliPick {
  const ranked = rankHits(hits, keyword);
  const { tokens, qualifiers, full: fullPhrase, suffixIntent, base } = splitQuery(keyword);
  const levelOf = (hit: SearchHit): SongMatchLevel => hit.matchLevel ?? matchOf(hit.title, base, fullPhrase).level;
  const hasAll = (hit: SearchHit, want: string[]): boolean => {
    const corpus = corpusOf(hit);
    return want.length > 0 && want.every((t) => corpus.includes(t));
  };
  const negatesQualifier = (hit: SearchHit): boolean => qualifiers.some((t) =>
    new RegExp(`(?:不是|并非|非|没有|无)${escapeRe(t)}`).test(norm(hit.title)));
  // 只有歌名级命中（同名，或同名 + 歌手/版本尾巴）才可能是用户点的那首。只是标题里
  // 包含这个词（Remember 之于 Always Remember Us This Way）是另一首歌，绝不自动开跑。
  const matched = ranked.filter((hit) => {
    const level = levelOf(hit);
    return (level === 'exact' || level === 'suffix') && hasAll(hit, tokens) && !negatesQualifier(hit);
  });
  // 一条都没匹配到：把最接近的几条列出来，让用户自己判断。
  if (!matched.length) {
    if (!ranked.length) return { confident: false, reason: 'no-result', candidates: [] };
    const partial = ranked.some((hit) => levelOf(hit) === 'partial' && !negatesQualifier(hit));
    return { confident: false, reason: partial ? 'partial' : 'weak-match', candidates: ranked.slice(0, limit) };
  }
  // 附加片段是硬条件：有带片段的候选时，明显不符的候选不进首选。
  const strict = qualifiers.length ? matched.filter((hit) => hasAll(hit, qualifiers)) : matched;
  const pool = strict.length ? strict : matched;
  const top = pool[0]!;
  const second = pool[1];
  const low = top.title.toLowerCase();
  const duration = top.durationSec;
  const short = duration > 0 && duration < 60;
  const missingQualifier = qualifiers.length > 0 && !hasAll(top, qualifiers);
  const topFull = fullPhrase !== '' && corpusOf(top).includes(fullPhrase);
  const renditionOnly = !suffixIntent && isRendition(low) && !GOOD_TITLE.test(low);
  // 坏词、标题党、明显不是一首歌的时长、点名片段却没带上、只有翻唱/现场标记：都交给用户。
  if (BAD_TITLE.test(low) || CLICKBAIT_TITLE.test(low) || short || missingQualifier || renditionOnly) {
    return { confident: false, reason: 'version', candidates: pool.slice(0, limit) };
  }
  if ((top.score ?? 0) < 8 && !topFull) {
    return { confident: false, reason: 'weak-match', candidates: pool.slice(0, limit) };
  }
  // 同名曲的多个版本：同一录音的不同搬运（原版 / 无损 / Hi-res）可以确定；
  // 不同歌手、或不同演绎（现场 / 翻唱 / remix）要问用户。
  if (second && !BAD_TITLE.test(second.title.toLowerCase())) {
    const gap = (top.score ?? 0) - (second.score ?? 0);
    const topArtist = top.artist ?? artistOf(top.title, base, fullPhrase || base);
    const secondArtist = second.artist ?? artistOf(second.title, base, fullPhrase || base);
    if (topArtist && secondArtist && topArtist !== secondArtist) {
      return { confident: false, reason: 'ambiguous', candidates: pool.slice(0, limit) };
    }
    if (gap < 3 && renditionKinds(top.title) !== renditionKinds(second.title)) {
      return { confident: false, reason: 'ambiguous', candidates: pool.slice(0, limit) };
    }
  }
  return { confident: true, reason: 'ok', candidates: pool.slice(0, limit) };
}

/** 视频信息 + 音频流地址（dash 里码率最高那轨：分离与变声都吃音质，多几 MB 值得）。 */
export async function audioUrlOf(bvid: string): Promise<BiliAudio> {
  const view = await jsonGet<{
    code: number;
    data?: { cid?: number; title?: string; owner?: { name?: string }; duration?: number };
  }>(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  if (view.code !== 0 || !view.data?.cid) throw new Error(`取视频信息失败 code=${view.code}`);
  const cid = view.data.cid;
  const play = await jsonGet<{
    code: number;
    message?: string;
    data?: { dash?: { audio?: { baseUrl?: string; mimeType?: string; bandwidth?: number }[] } };
  }>(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&fnver=0&fourk=1`);
  if (play.code !== 0) throw new Error(`取播放地址失败 code=${play.code} ${play.message ?? ''}`.trim());
  const list = play.data?.dash?.audio ?? [];
  if (!list.length) throw new Error('这个视频没有独立音频轨（可能是直播/番剧，需要登录）');
  const best = [...list].sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
  if (!best?.baseUrl) throw new Error('音频地址为空');
  return {
    url: best.baseUrl,
    mime: best.mimeType ?? 'audio/mp4',
    title: String(view.data.title ?? ''),
    author: String(view.data.owner?.name ?? ''),
    durationSec: Number(view.data.duration ?? 0) || 0,
  };
}

/** 单次下载：412/403 由外层换 playurl 重试。 */
async function downloadOnce(url: string, dest: string, maxBytes: number): Promise<number> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`音频下载 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`音频 ${(buf.length / 1048576).toFixed(1)}MB 超过上限`);
  if (buf.length < 32 * 1024) throw new Error(`音频只有 ${buf.length} 字节，像是失效或风控页面`);
  await writeFile(dest, buf);
  return buf.length;
}

const wait = (ms: number): Promise<void> => (ms > 0 ? new Promise((done) => setTimeout(done, ms)) : Promise.resolve());

/**
 * 下载一条候选：最多三次，每次重新取 playurl（旧地址 412/过期时自然换新），
 * 退避 0.8s → 1.6s。
 */
export async function downloadAudio(
  bvid: string,
  dest: string,
  maxBytes = 200 * 1024 * 1024,
  opts: { attempts?: number } = {},
): Promise<DownloadedAudio> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const info = await audioUrlOf(bvid);
      const bytes = await downloadOnce(info.url, dest, maxBytes);
      return { ...info, bytes };
    } catch (err) {
      last = err;
      if (attempt + 1 < attempts) await wait(800 * 2 ** attempt);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** 默认客户端：搜索 + 下载；测试注入替身，不走网络。 */
export const defaultBiliClient: BiliClient = {
  search: (keyword, limit) => searchBili(keyword, limit),
  fetch: (bvid, dest, maxBytes) => downloadAudio(bvid, dest, maxBytes),
};
