import { build } from "esbuild";
import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const entryPoint = fileURLToPath(new URL("../src/life/reverse-life.worker.source.js", import.meta.url));
const outfile = fileURLToPath(new URL("../src/life/reverse-life.worker.bundle.js", import.meta.url));
const wasmSource = fileURLToPath(new URL("../node_modules/logic-solver-plus/mjs/minisat_static.wasm", import.meta.url));
const wasmOutput = fileURLToPath(new URL("../src/life/minisat_static.wasm", import.meta.url));

await build({
  entryPoints: [entryPoint],
  outfile,
  bundle: true,
  format: "esm",
  platform: "browser",
  external: ["module", "fs", "path", "url"],
  target: ["es2020"],
  legalComments: "none",
  banner: {
    js: "/* Bundles MIT-licensed logic-solver-plus 0.2.2. See THIRD_PARTY_NOTICES.md. */",
  },
});

await copyFile(wasmSource, wasmOutput);

console.log("Bundled the reverse-Life MiniSat worker and copied its WebAssembly module.");
