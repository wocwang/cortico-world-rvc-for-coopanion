/**
 * 面板 bundle：`src/webui/client.ts` → `dist/webui.js` + `dist/webui.css`。
 * 两个产物名写死在 package.json 的 `cortico.webUiClient` / `webUiStyle` 里，服务端自己分配 URL。
 *
 * 浏览器侧只允许 `import type` 框架：那些 import 编译期就被擦掉。
 * 构建若报 "Could not resolve cortico/…"，说明有一处运行时依赖漏网，去把它本地化，别在这里放行。
 */
import * as esbuild from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const outdir = `${root}dist`;

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const result = await esbuild.build({
  entryPoints: [{ in: `${root}src/webui/client.ts`, out: 'webui' }],
  outdir,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  minify: true,
  // 不打 sourcemap：`src/webui/client.ts` 本来就在包里，map 只是让 tgz 多一倍体积。
  sourcemap: false,
  metafile: true,
});

for (const [path, info] of Object.entries(result.metafile.outputs)) {
  if (path.endsWith('.map')) continue;
  console.log(`${path.replace(/\\/g, '/')}  ${(info.bytes / 1024).toFixed(1)} KB`);
}
