#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const IMPORT = 'import { errorFromCaught } from "@/lib/safe-error-message";';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === ".next") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?)$/.test(name)) out.push(p);
  }
  return out;
}

let fixed = 0;
for (const path of walk(join(root, "src"))) {
  const src = readFileSync(path, "utf8");
  if (!src.includes("errorFromCaught")) continue;
  if (src.includes('from "@/lib/safe-error-message"')) continue;
  const lines = src.split("\n");
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("import ")) insertAt = i + 1;
  }
  lines.splice(insertAt, 0, IMPORT);
  writeFileSync(path, lines.join("\n"));
  fixed++;
  console.log("import added", path.replace(root + "/", ""));
}
console.log(`fixed ${fixed} files`);
