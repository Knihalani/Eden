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

const patterns = [
  [
    /setError\(\s*err\s+instanceof\s+Error\s*\?\s*err\.message\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)/g,
    "setError(errorFromCaught(err, $1))",
  ],
  [
    /setError\(\s*e\s+instanceof\s+Error\s*\?\s*e\.message\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)/g,
    "setError(errorFromCaught(e, $1))",
  ],
];

let changed = 0;
for (const path of walk(join(root, "src"))) {
  let src = readFileSync(path, "utf8");
  let next = src;
  for (const [re, rep] of patterns) {
    next = next.replace(re, rep);
  }
  if (next === src) continue;

  if (!next.includes("errorFromCaught")) {
    const lines = next.split("\n");
    let insertAt = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("import ")) insertAt = i + 1;
    }
    lines.splice(insertAt, 0, IMPORT);
    next = lines.join("\n");
  }

  writeFileSync(path, next);
  changed++;
  console.log("patched", path.replace(root + "/", ""));
}
console.log(`done — ${changed} files`);
