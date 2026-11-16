/**
 * `rvc_sing` 的选歌规则：按歌名在翻唱库里找，没给歌名就随机挑一首。
 *
 * 类型默认清唱（`clean`）；只有用户明确说「翻唱 / 带伴奏」时调用方才传 `cover`。
 *
 * 匹配分三档：
 * - 规范化后完全相同 → 直接播；
 * - 只是包含关系 / 版本后缀不同（「雨爱」vs「雨爱 司凤版」）→ 不替用户做主，
 *   返回可选项让桌宠先问；
 * - 完全对不上 → 再由 World 决定去 B 站找原版。
 */
import { readLibrary, songKey, type LibraryEntry, type LibraryKind } from './library.ts';

export interface SingQuery {
  /** 歌名，可带《》、扩展名；省略表示随机。 */
  song?: string;
  kind?: LibraryKind;
  /** `bilibili` 表示跳过库里的相近版本，直接按原版去 B 站找。 */
  source?: 'library' | 'bilibili';
}

export interface SingIssue {
  code: 'empty' | 'not-found' | 'kind-missing';
  /** 直接给模型看的英文说明。 */
  message: string;
}

export interface SingAmbiguous {
  /** 只是包含关系 / 版本后缀不同的候选，最多 6 条。 */
  entries: LibraryEntry[];
  /** 先让用户确认，不要直接播。 */
  message: string;
}

export type SingPick = { entry: LibraryEntry } | { ambiguous: SingAmbiguous } | { issue: SingIssue };

const kindLabel = (kind: LibraryKind): string =>
  kind === 'clean' ? 'clean vocal (no backing track)' : 'cover (with backing track)';

const titles = (entries: LibraryEntry[], limit = 8): string =>
  [...new Set(entries.map((entry) => entry.title))].slice(0, limit).join(' / ');

/** 只看包含关系/版本后缀；完全相同不算。距离越近越靠前，同距离取最新的。 */
function closeMatches(entries: LibraryEntry[], key: string): LibraryEntry[] {
  return entries
    .filter((entry) => entry.song !== key && (entry.song.includes(key) || key.includes(entry.song)))
    .sort((a, b) =>
      Math.abs(a.song.length - key.length) - Math.abs(b.song.length - key.length)
      || Date.parse(b.createdAt) - Date.parse(a.createdAt));
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

  // 精确命中：规范化后的歌名完全相同，直接播，不再问。
  const exact = same
    .filter((entry) => entry.song === key)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (exact.length) return { entry: exact[0]! };

  // 只是包含关系 / 版本后缀不同：先问用户是不是这一版。
  const close = closeMatches(same, key);
  if (close.length) {
    const list = close.slice(0, 6);
    const names = list.map((entry) => `"${entry.title}"`).join(', ');
    return {
      ambiguous: {
        entries: list,
        message: `"${query.song}" is not an exact title in the library. Close matches: ${names}. Ask the person whether they meant one of these versions. To play one, call rvc_sing again with that exact title as song. If they want the original instead, call rvc_sing again with song "${query.song}" and source "bilibili".`,
      },
    };
  }

  // 歌名对得上但类型不对：告诉模型它只存了另一种，别偷偷放带伴奏的版本。
  const otherExact = all.filter((entry) => entry.song === key);
  if (otherExact.length) {
    const other = [...new Set(otherExact.map((entry) => entry.kind))].map(kindLabel).join(', ');
    return {
      issue: {
        code: 'kind-missing',
        message: `"${query.song}" is saved only as ${other}. Tell the person; only use it if they explicitly ask for that version.`,
      },
    };
  }
  const otherClose = closeMatches(all.filter((entry) => entry.kind !== kind), key);
  if (otherClose.length) {
    const other = [...new Set(otherClose.map((entry) => entry.kind))].map(kindLabel).join(', ');
    return {
      issue: {
        code: 'kind-missing',
        message: `"${query.song}" is only close to ${titles(otherClose)}, saved as ${other}. Tell the person; do not silently switch the type.`,
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
