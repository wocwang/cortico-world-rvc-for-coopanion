import type { ToolSpec } from 'cortico/core/types.ts';

/** 工具声明（不含 handler）；`describe.tools` 与 `tools()` 都从这里取。 */
export const RVC_TOOL_DECLS: readonly ToolSpec[] = [{
  name: 'rvc_sing',
  description: 'Play a song from this computer\'s local RVC cover library through the speakers. Use it when the person asks you to sing or play a saved song: "给我唱《起风了》", "来一首", "来首清唱". Pass song when they name a song; omit song to pick a random saved one. kind defaults to "clean" (vocals only, no backing track): only pass "cover" when the person explicitly asks for a cover or with backing track. A new call stops the previous song first. It returns as soon as playback starts — do not wait for the whole song. When the library is empty or the song is not saved, it returns an explanation; relay it instead of pretending you sang.',
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
    },
    required: [],
  },
}];
