// F9 (D1104): the 12 calibration examples of recipe L2 (recorded API replies from the tune half, outside the scored
// sample): bun make-examples.ts DUMP.jsonl TUNE_META.json OUT.txt
import { readFileSync, writeFileSync } from "node:fs";
import { halfOf, readDump } from "../../../src/lab/check-api-replay";

const [dump, tuneMeta, out] = process.argv.slice(2);
const rows = readDump(dump!).filter((r) => r.yes !== null && halfOf(r) === "tune");
const scored = JSON.parse(readFileSync(tuneMeta!, "utf8")) as { items: string[] }[];
const used = new Set(scored.map((m) => m.items.join("|")));
const pool = rows.filter((r) => !used.has(r.items.map((i) => i.id).join("|")));
let s = 99;
const rand = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const silent = pool
  .filter((r) => !r.yes!.length)
  .sort(() => rand() - 0.5)
  .slice(0, 4);
const spoke = pool
  .filter((r) => r.yes!.length)
  .sort(() => rand() - 0.5)
  .slice(0, 8);
const examples = [...silent, ...spoke]
  .sort(() => rand() - 0.5)
  .map((r, k) => {
    const items = r.items
      .map((it, i) => {
        const from = it.from ? ` from ${it.from}` : "";
        return `  ${i + 1}. [${it.source} ${it.date}${from}] ${it.title}: ${it.text.slice(0, 160)}`;
      })
      .join("\n");
    const head = `EXAMPLE ${k + 1}\nRequest: ${r.request}\nToday: ${r.today}\nItems:\n${items}\n`;
    return `${head}The model's actual reply: ${r.reply}\n`;
  });
writeFileSync(out!, examples.join("\n"));
console.log(examples.length, examples.join("").length);
