/**
 * 标题匹配的通用规则：不维护具体的版本名 / 演唱者名单。
 *
 * 两类线索：
 * - **查询结构**：按空白与标点分词，第一个词当歌名，后面的词都当附加片段
 *   （「某歌 某某版」「某歌 歌手名」「某歌 0.9x版」……）。不管后缀是什么词，
 *   只要它在查询里单独成段，就按同一套权重处理。
 * - **文字形态**：常见的版本标记（xxx版、翻唱、cover、remix、live、MV、伴奏……）
 *   用来识别单个词里的版本意图，并判断两个标题之间多出来的片段是不是「版本 / 演唱者」。
 *
 * 所以未收录的新后缀也能生效：多段查询靠结构识别；连写的标题靠「xxx版」、分隔符、
 * 或紧贴歌名的人名/团体名（2-8 个汉字、首字母大写的拉丁词）识别。
 */

/** 规范化时保留的字符：Unicode 字母与数字（汉字属于 Letter）。 */
const KEEP_CHAR = /[\p{L}\p{N}]/u;
/** 分词：字母/数字之外的连续字符都算分隔。 */
const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;

/** 检索名规范化：只留字母与数字，统一小写；表情、书名号、空格、标点都不参与比较。 */
export function norm(text: string): string {
  const raw = String(text || '').toLowerCase();
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (KEEP_CHAR.test(ch)) out += ch;
  }
  return out;
}

/** 规范化并记录每个字符在原文中的位置，用于判断附加片段前有没有分隔符。 */
function normWithMap(text: string): { value: string; map: number[] } {
  const raw = String(text || '').toLowerCase();
  let value = '';
  const map: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (!KEEP_CHAR.test(ch)) continue;
    value += ch;
    map.push(i);
  }
  return { value, map };
}

export function tokensOf(query: string): string[] {
  return String(query || '')
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .map((token) => norm(token))
    .filter((token) => token.length > 0);
}

const CJK_ONLY = /^[\u3400-\u9fff]+$/;
const SPEED_MULTIPLIER = /^\d+(?:\.\d+)?x$/;

/** 拉丁词边界匹配：避免 "discover" 命中 "cover"、"alive" 命中 "live"。 */
function latinWord(text: string, words: string): boolean {
  return new RegExp(`(?:^|[^a-z])(?:${words})(?:[^a-z]|$)`).test(text);
}

/** 演绎方式分类。只有分类不同（现场 vs MV、原版 vs 翻唱）才需要问用户，同一类的不同搬运不用问。 */
const RENDITION_KINDS: Array<{ kind: string; test: (low: string) => boolean }> = [
  { kind: 'cover', test: (s) => /翻唱|翻自/.test(s) || latinWord(s, 'covers?|covered') },
  { kind: 'live', test: (s) => /现场|演唱会/.test(s) || latinWord(s, 'live') },
  { kind: 'remix', test: (s) => /加速|减速|慢速|升调|降调|变调|改编|重制|重置/.test(s) || latinWord(s, 'remix|dj|remaster(?:ed)?') },
  { kind: 'instrumental', test: (s) => /伴奏|纯音乐|消音|卡拉ok|ktv/.test(s) || latinWord(s, 'instrumental|inst|karaoke') },
  { kind: 'vocal', test: (s) => /男版|女版|男声|女声|童声|合唱|清唱/.test(s) || latinWord(s, 'acoustic') },
  { kind: 'mv', test: (s) => latinWord(s, 'mv') },
];

/** 返回演绎方式签名（排序后用 + 连接）；空串表示没有版本标记。 */
export function renditionKinds(text: string): string {
  const low = String(text || '').toLowerCase();
  return RENDITION_KINDS
    .filter((item) => item.test(low))
    .map((item) => item.kind)
    .sort()
    .join('+');
}

export function isRendition(text: string): boolean {
  return renditionKinds(text) !== '';
}

/**
 * 一个片段是否像版本 / 演唱者后缀：
 * 任何「xxx版」、加速倍率（0.9x）、常见演绎标记、feat/ft。
 * 这里只认形态，不认具体名字；人名与团体名由 {@link isAppendedSuffix} 的结构规则处理。
 */
export function isSuffixMarker(text: string): boolean {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (isRendition(raw)) return true;
  const plain = norm(raw);
  return plain.endsWith('版') || SPEED_MULTIPLIER.test(plain)
    || latinWord(raw.toLowerCase(), 'feat|ft');
}

/** 附加片段是否像版本 / 演唱者：有分隔符、有版本标记、连写的人名（2-8 汉字或首字母大写拉丁词）。 */
export function isAppendedSuffix(extra: string, boundary: boolean): boolean {
  const raw = String(extra || '').trim();
  const plain = norm(raw);
  if (!plain) return false;
  if (boundary) return true;
  if (isSuffixMarker(raw)) return true;
  if (CJK_ONLY.test(plain) && plain.length >= 2 && plain.length <= 8) return true;
  // 连写的英文人名 / 团体名：保留原始大小写，避免把 "Rainbow" 拆成 "Rain"+"bow"。
  return /^[A-Z][A-Za-z0-9.&' -]{1,15}$/.test(raw);
}

export interface AppendedSuffix {
  /** 短名在长名中的规范化位置；0 表示前缀命中。 */
  at: number;
  /** 长名比短名多出来的片段（规范化后）。 */
  extra: string;
  /** 多出来的片段是否由空白 / 括号 / 标点隔开。 */
  boundary: boolean;
  /** 这个片段是否像版本或演唱者后缀。 */
  suffix: boolean;
}

/**
 * 判断长标题是不是「短标题 + 一个附加片段」。
 * 例：「某歌」+「某歌 某某版」→ extra「某某版」、有分隔符；
 * 「雨」+「雨天」→ extra「天」，既无分隔符也不是人名，返回 `suffix=false`。
 */
export function appendedSuffix(shortText: string, longText: string): AppendedSuffix | null {
  const short = norm(shortText);
  if (!short) return null;
  const long = normWithMap(longText);
  if (short === long.value) return null;
  const at = long.value.indexOf(short);
  if (at < 0) return null;
  const end = at + short.length;
  const tail = long.value.slice(end);
  const head = long.value.slice(0, at);
  const extra = tail || head;
  if (!extra) return null;
  let boundary = false;
  if (tail) {
    const first = long.map[end];
    boundary = first !== undefined && first > 0 && !KEEP_CHAR.test(String(longText)[first - 1]!);
  } else {
    const last = long.map[at - 1];
    boundary = last !== undefined && last + 1 < String(longText).length
      && !KEEP_CHAR.test(String(longText)[last + 1]!);
  }
  return { at, extra, boundary, suffix: isAppendedSuffix(extra, boundary) };
}

export interface QueryParts {
  /** 第一个词：歌名（多段查询时）。 */
  base: string;
  /** 歌名之后的词：版本 / 演唱者 / 团体等附加片段，不依赖具体词表。 */
  qualifiers: string[];
  /** 全部查询词。 */
  tokens: string[];
  /** 规范化后的完整查询。 */
  full: string;
  /** 查询本身是否带有「版本 / 演唱者」意图。 */
  suffixIntent: boolean;
}

/** 按结构拆查询：多段时后续词一律是附加片段；单段时看有没有版本形态标记。 */
export function splitQuery(query: string): QueryParts {
  const tokens = tokensOf(query);
  const qualifiers = tokens.slice(1);
  const allLatin = tokens.length > 0 && tokens.every((token) => /^[a-z0-9]+$/.test(token));
  const suffixIntent = tokens.length > 1
    ? !allLatin || qualifiers.some((token) => isSuffixMarker(token) || isAppendedSuffix(token, false))
    : tokens.length === 1 && isSuffixMarker(tokens[0]!);
  return { base: tokens[0] ?? '', qualifiers, tokens, full: norm(query), suffixIntent };
}
