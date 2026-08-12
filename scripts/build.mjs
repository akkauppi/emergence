import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = fileURLToPath(new URL("../dist/", import.meta.url));

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(`${root}index.html`, `${output}index.html`);
await cp(`${root}src`, `${output}src`, { recursive: true });

console.log("Built the dependency-free static app in dist/");
