import type { ToolSpec } from 'cortico/core/types.ts';

/** 工具声明（不含 handler）；`describe.tools` 与 `tools()` 都从这里取。 */
export const RVC_TOOL_DECLS: readonly ToolSpec[] = [{
  name: 'rvc_sing',
  description: 'Play a song from this computer\'s local RVC cover library through the speakers. Use it when the person asks you to sing or play a saved song: "给我唱《起风了》", "来一首", "来首清唱". Pass song when they name a song; omit song to pick a random saved one. kind defaults to the configured singing type (clean vocals unless changed in settings): only pass "cover" when the person explicitly asks for a cover or with backing track, or "clean" when they explicitly ask for vocals only. A new call stops the previous song and any in-progress auto generation first. An exact saved title plays immediately. If the saved title is the same song plus an extra version or performer fragment (anything like "...版", "... cover", "... live", a singer name, or a group name), the tool does NOT play it: it returns the close matches and you must ask the person whether they meant that version. If they say no, call again with the same song and source "bilibili" to look for the original. If no saved title is close, it searches Bilibili, starts a one-click cover in the background, saves it to the library and plays it when done; this takes 2-5 minutes, and the tool returns right away with a "generating" message — do not wait, and tell the person playback will start automatically. If Bilibili has no reliable match it returns the candidate list instead of guessing. When there is no song name and the library is empty, it returns an explanation; relay it instead of pretending you sang.',
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
        description: 'clean = vocals only. cover = with backing track. Omit it to use the configured default singing type.',
      },
      source: {
        type: 'string',
        enum: ['library', 'bilibili'],
        description: 'library = use the saved cover library first (default). bilibili = skip close library versions and look for the original on Bilibili; use only after the person rejects a close match returned by the tool.',
      },
    },
    required: [],
  },
}, {
  name: 'rvc_find',
  description: 'Search the local RVC cover library by keywords instead of requiring an exact title. Use it when the person asks what songs you can sing, gives a partial or fuzzy title, or asks whether a song is saved. An empty query lists the saved songs (up to limit). Returns exact titles with clean/cover labels; then call rvc_sing with one of those exact titles. If nothing matches, ask the person rather than pretending.',
  tags: ['read'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: {
        type: 'string',
        maxLength: 200,
        description: 'Keywords to match against saved titles; empty lists all saved songs.',
      },
      kind: {
        type: 'string',
        enum: ['clean', 'cover'],
        description: 'Only return this kind; omit for both.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximum results; default 20.',
      },
    },
    required: [],
  },
}, {
  name: 'rvc_status',
  description: 'Check what the RVC singer is doing right now: playing a song, preparing a cover in the background, or idle. Use it when the person asks whether you are still singing, whether it finished, or what is playing.',
  tags: ['read'],
  parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
}, {
  name: 'rvc_stop',
  description: 'Stop the current RVC playback and cancel any cover that is still being prepared in the background. Use it when the person says stop singing, be quiet, or switch away. Returns whether something was playing or being prepared.',
  tags: ['act'],
  parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
}];
