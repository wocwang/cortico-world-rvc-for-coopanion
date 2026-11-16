import type { ToolSpec } from 'cortico/core/types.ts';

/** 工具声明（不含 handler）；`describe.tools` 与 `tools()` 都从这里取。 */
export const RVC_TOOL_DECLS: readonly ToolSpec[] = [{
  name: 'rvc_sing',
  description: 'Play a song from this computer\'s local RVC cover library through the speakers. Use it when the person asks you to sing or play a saved song: "给我唱《起风了》", "来一首", "来首清唱". Pass song when they name a song; omit song to pick a random saved one. kind defaults to "clean" (vocals only, no backing track): only pass "cover" when the person explicitly asks for a cover or with backing track. A new call stops the previous song and any in-progress auto generation first. An exact saved title plays immediately. If the request only partially matches a saved title (e.g. "雨爱" when the library has "雨爱 司凤版"), the tool does NOT play it: it returns the close matches and you must ask the person whether they meant that version. If they say no, call again with the same song and source "bilibili" to look for the original. If no saved title is close, it searches Bilibili, starts a one-click cover in the background, saves it to the library and plays it when done; this takes 2-5 minutes, and the tool returns right away with a "generating" message — do not wait, and tell the person playback will start automatically. If Bilibili has no reliable match it returns the candidate list instead of guessing. When there is no song name and the library is empty, it returns an explanation; relay it instead of pretending you sang.',
  tags: ['speak'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      song: {
        type: 'string',
        maxLength: 200,
        description: 'Song name to look up in the saved cover library. Chinese titles with 《》 are fine. Omit to play a random saved song.',
      },
      kind: {
        type: 'string',
        enum: ['clean', 'cover'],
        description: 'clean = vocals only (default; use unless the person explicitly wants a cover). cover = with backing track.',
      },
      source: {
        type: 'string',
        enum: ['library', 'bilibili'],
        description: 'library = use the saved cover library first (default). bilibili = skip close library versions and look for the original on Bilibili; use only after the person rejects a close match returned by the tool.',
      },
    },
    required: [],
  },
}];
