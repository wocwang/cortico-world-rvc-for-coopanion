/**
 * `rvc_sing` 的选歌规则：按歌名在翻唱库里找，没给歌名就随机挑一首。
 *
 * 类型默认清唱（`clean`）；只有用户明确说「翻唱 / 带伴奏」时调用方才传 `cover`。
 * 库为空、只有另一种类型、歌名对不上都返回文本原因，不抛错。
 */
import { readLibrary, songKey, type LibraryEntry, type LibraryKind } from './library.ts';

export interface SingQuery {
  /** 歌名，可带《》、扩展名；省略表示随机。 */
  song?: string;
  kind?: LibraryKind;
}

export interface SingIssue {
  code: 'empty' | 'not-found' | 'kind-missing';
  /** 直接给模型看的英文说明。 */
  message: string;
}

export type SingPick = { entry: LibraryEntry } | { issue: SingIssue };

const kindLabel = (kind: LibraryKind): string =>
  kind === 'clean' ? 'clean vocal (no backing track)' : 'cover (with backing track)';

const titles = (entries: LibraryEntry[], limit = 8): string =>
  [...new Set(entries.map((entry) => entry.title))].slice(0, limit).join(' / ');

/** 精确优先，其次包含；同档取最新的。 */
function rank(entry: LibraryEntry, key: string): number {
  return entry.song === key ? 0 : entry.song.includes(key) || key.includes(entry.song) ? 1 : 9;
}

export function pickSong(root: string, query: SingQuery, random: () => number = Math.random): SingPick {
  const kind: LibraryKind = query.kind === 'cover' ? 'cover' : 'clean';
  const all = readLibrary(root).entries;
  if (!all.length) {
    return {
      issue: {
        code: 'empty',
        message: 'The cover library is empty. Sing a song in the RVC panel and save it to the cover library first.',
      },
    };
  }
  const same = all.filter((entry) => entry.kind === kind);
  const key = songKey(query.song ?? '');
  if (!key) {
    if (!same.length) {
      const other = [...new Set(all.map((entry) => entry.kind))].map(kindLabel).join(', ');
      return {
        issue: {
          code: 'kind-missing',
          message: `The cover library has no ${kindLabel(kind)} yet; it only has ${other}. Ask the person to save a ${kind === 'clean' ? 'clean' : 'cover'} version in the RVC panel.`,
        },
      };
    }
    const at = Math.min(same.length - 1, Math.max(0, Math.floor(random() * same.length)));
    return { entry: same[at]! };
  }
  const hits = same
    .filter((entry) => rank(entry, key) < 9)
    .sort((a, b) => rank(a, key) - rank(b, key) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (hits.length) return { entry: hits[0]! };
  // 歌名对得上但类型不对：告诉模型它只存了另一种，别偷偷放带伴奏的版本。
  const otherHits = all.filter((entry) => rank(entry, key) === 0);
  if (otherHits.length) {
    const other = [...new Set(otherHits.map((entry) => entry.kind))].map(kindLabel).join(', ');
    return {
      issue: {
        code: 'kind-missing',
        message: `"${query.song}" is saved only as ${other}. Tell the person; only use it if they explicitly ask for that version.`,
      },
    };
  }
  return {
    issue: {
      code: 'not-found',
      message: `No saved song matches "${query.song}". Saved songs: ${titles(all) || '(none)'}.`,
    },
  };
}
