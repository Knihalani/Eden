/**
 * F13: the anticipation pass over each world's sheet, through the queue transport (D1101). LAB ONLY, sim data.
 *
 *   bun packages/sim/lab/f13/pass.ts queue SHEETS.jsonl QUEUE_DIR        # write the pass's requests as pending
 *   bun packages/sim/lab/f13/pass.ts read  SHEETS.jsonl QUEUE_DIR OUT.jsonl   # parse answered ones: per world
 *
 * SHEETS.jsonl is `sheet.py`'s output. Worlds with the same sheet (a reworded suite and its base) share one pass.
 * Each pass is ceil(rules / ANTICIPATE_CHUNK) requests: the whole sheet as the first user turn (the cached prefix),
 * the chunk's rule range as the second. Role `eden.anticipate`, model claude-haiku-5-5.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANTICIPATE_CHUNK,
  ANTICIPATE_MAX_RULES,
  anticipateMessages,
  parseAnticipations,
  type SheetRule,
} from "./anticipate";
import { ensureQueue, keyOf, queueDirs, requestOf, writeAtomic } from "../../src/lab/queue-transport";

const TODAY = "Tuesday 27 October 2026";
const MODEL = "claude-haiku-5-5";
const ROLE = "eden.anticipate";

type Card = { kind: string; statement: string; start?: string; end?: string; entities?: string[] };
type World = {
  suite: string;
  seed: number;
  variant: string;
  tasks: { template: string; request: string; planted: string }[];
  sheet: { id: string; title: string; text: string; c: Card; r: string[] }[];
};

const [cmd, sheetsPath, dir, outPath] = process.argv.slice(2);
const worlds: World[] = readFileSync(sheetsPath!, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

/** The sheet in a fixed order that does not put planted items last (they are appended to the world). */
function rulesOf(w: World): SheetRule[] {
  const h = (s: string) => createHash("sha1").update(s).digest("hex");
  return w.sheet
    .map((s) => ({
      id: s.id,
      kind: s.c.kind,
      statement: s.c.statement,
      title: s.title,
      source: s.id.split(":")[0]!,
      ...(s.c.start ? { start: s.c.start } : {}),
      ...(s.c.end ? { end: s.c.end } : {}),
    }))
    .sort((a, b) => (h(a.id) < h(b.id) ? -1 : 1))
    .slice(0, ANTICIPATE_MAX_RULES);
}

function bodies(rules: SheetRule[]) {
  const out = [];
  for (let from = 0; from < rules.length; from += ANTICIPATE_CHUNK) {
    const { system, messages } = anticipateMessages(rules, TODAY, from, from + ANTICIPATE_CHUNK);
    out.push({
      from,
      body: {
        model: MODEL,
        system,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: 4_000,
      },
    });
  }
  return out;
}

if (cmd === "queue") {
  ensureQueue(dir!);
  const q = queueDirs(dir!);
  let wrote = 0;
  let had = 0;
  const keys = new Set<string>();
  for (const w of worlds) {
    for (const { body } of bodies(rulesOf(w))) {
      const key = keyOf(ROLE, body);
      if (keys.has(key)) continue;
      keys.add(key);
      if (existsSync(join(q.done, `${key}.json`)) || existsSync(join(q.taken, `${key}.json`))) {
        had++;
        continue;
      }
      writeAtomic(join(q.pending, `${key}.json`), requestOf(key, ROLE, body));
      wrote++;
    }
  }
  console.log(JSON.stringify({ worlds: worlds.length, requests: keys.size, wrote, had }));
} else if (cmd === "read") {
  const q = queueDirs(dir!);
  const lines: string[] = [];
  let missing = 0;
  let unreadable = 0;
  for (const w of worlds) {
    const rules = rulesOf(w);
    const ants = [];
    let complete = true;
    for (const { from, body } of bodies(rules)) {
      const f = join(q.done, `${keyOf(ROLE, body)}.json`);
      if (!existsSync(f)) {
        missing++;
        complete = false;
        continue;
      }
      const got = parseAnticipations(
        JSON.parse(readFileSync(f, "utf8")).answer?.text ?? "",
        rules,
        from,
        from + ANTICIPATE_CHUNK,
      );
      if (!got) unreadable++;
      ants.push(...(got ?? []));
    }
    lines.push(
      JSON.stringify({ suite: w.suite, seed: w.seed, variant: w.variant, complete, rules: rules.length, ants }),
    );
  }
  writeFileSync(outPath!, `${lines.join("\n")}\n`);
  console.log(JSON.stringify({ worlds: worlds.length, missing, unreadable }));
} else {
  console.error("usage: pass.ts queue|read SHEETS.jsonl QUEUE_DIR [OUT.jsonl]");
  process.exit(2);
}
