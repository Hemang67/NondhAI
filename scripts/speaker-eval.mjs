// Builds and runs the speaker-identification evaluation (scripts/speaker-eval/main.ts).
// Dev only: nothing here is bundled into the app. See docs/SPEAKER_ID_AUDIT.md.
//   node scripts/speaker-eval.mjs synth|run|embed-bench ...   (Node)
//   node scripts/speaker-eval.mjs real ...                     (Electron: the user's own recordings)
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const real = process.argv[2] === "real";
const outfile = join(root, "out", "speaker-eval", real ? "real.cjs" : "main.cjs");
await build({
  entryPoints: [join(root, "scripts", "speaker-eval", real ? "real.ts" : "main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  tsconfig: join(root, "tsconfig.base.json"),
  external: ["sherpa-onnx-node", "ffmpeg-static", "electron"],
  logLevel: "warning",
});
const exe = real ? createRequire(import.meta.url)("electron") : process.execPath;
const args = real ? [outfile, ...process.argv.slice(2)] : ["--max-old-space-size=8192", outfile, ...process.argv.slice(2)];
// Shells started from VS Code set ELECTRON_RUN_AS_NODE, which would run Electron as plain Node.
const env = { ...process.env };
if (real) delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(exe, args, { stdio: "inherit", cwd: root, env });
process.exit(r.status ?? 1);
