import type { ToolSpec } from 'cortico/core/types.ts';

/** 工具声明（不含 handler）；`describe.tools` 与 `tools()` 都从这里取。 */
export const RVC_TOOL_DECLS: readonly ToolSpec[] = [{
  name: 'rvc_sing',
  description: 'Play a song from this computer\'s local RVC cover library through the speakers. Use it when the person asks you to sing or play a saved song: "给我唱《起风了》", "来一首", "来首清唱". Pass song when they name a song; omit song to pick a random saved one. kind defaults to the configured singing type (clean vocals unless changed in settings): only pass "cover" when the person explicitly asks for a cover or with backing track, or "clean" when they explicitly ask for vocals only. A new call stops the previous song and any in-progress auto generation first. An exact saved title plays immediately. If the saved title is the same song plus an extra version or performer fragment (anything like "...版", "... cover", "... live", a singer name, or a group name), the tool does NOT play it: it returns the close matches and you must ask the person whether they meant that version. If they say no, call again with the same song and source "bilibili" to look for the original. If no saved title is close, it searches Bilibili and returns a ranked candidate list with BV ids — it never starts a video silently. If the first candidate is clearly the song the person meant, call again right away with the same song and bvid set to it; if it is not clearly right, show a few numbered candidates and ask which one. Either way you may pass title with the song name you want shown and saved (your call how much uploader promo or quality noise to strip; omit it to let the video title be cleaned automatically). That second call downloads the chosen video, starts a one-click cover in the background, saves it to the library and plays it when done; this takes 2-5 minutes, and the tool returns right away with a "generating" message — do not wait, and tell the person playback will start automatically. When there is no song name and the library is empty, it returns an explanation; relay it instead of pretending you sang.',
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
      bvid: {
        type: 'string',
        maxLength: 20,
        description: 'A Bilibili BV id from a candidate list returned by this tool. Use it after the person picks one specific video; it downloads that exact video instead of searching again.',
      },
      title: {
        type: 'string',
        maxLength: 120,
        description: 'Optional song title to show, save to the library and announce. Use it when you have seen the video title in a candidate list or the person told you how the song should be named; decide yourself which promo, quality tags or uploader chatter to drop, but keep the song name, artist and meaningful version words (live, cover, instrumental). If omitted, the video title is cleaned automatically.',
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
}, {
  name: 'rvc_start',
  description: 'Start the local RVC engine and wait until it is ready. Use it when the person asks you to start or open RVC, warm it up, or get ready to sing. A cold start can take tens of seconds; say you are starting it before calling. Starting is idempotent: if the engine is already ready it returns immediately. If it fails, returns the reason so you can relay it instead of pretending.',
  tags: ['act'],
  parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
}, {
  name: 'rvc_volume',
  description: 'Set or read the RVC playback volume (0-100). Use it when the person asks to make the song louder or quieter, or gives a volume level. Changes apply to the current song immediately by restarting it at the same position (a brief gap of a few tenths of a second) and to later songs. Pass level for an absolute value, or delta for a relative change; pass neither to read the current volume.',
  tags: ['act'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      level: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: 'Absolute volume 0-100. Takes priority over delta.',
      },
      delta: {
        type: 'integer',
        minimum: -100,
        maximum: 100,
        description: 'Relative change from the current volume, for example -20 for quieter or 15 for louder.',
      },
    },
    required: [],
  },
}];
