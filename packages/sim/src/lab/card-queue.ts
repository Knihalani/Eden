/**
 * The subagent card transport (F8, D1102): stands in for the card model when no API credit is available. The shipped
 * enricher runs as usual (`cold-start.ts --queue-dir D`); each card call it makes is answered item by item from
 * `D/answers/*.jsonl` when every item of the batch has an answer, and otherwise each unanswered item is written to
 * `D/pending/<key>.json` and the call fails (the enricher counts a failure, as for a 400). Subagents answer the
 * pending items (`card-queue-cli.ts`) and the run is repeated until nothing is pending; the replies are then composed
 * in the card call's own JSON, so the real maker parses them (`parseCards`, `parseRequests`) and `--cards-out`
 * records them exactly as a model call's.
 *
 * Answers are per item, not per call: the enricher's batches depend on timing (lanes, gather), so a prompt keyed as a
 * whole would rarely repeat between runs, while an item's block (its source, date, title and text) does. An item
 * answered alone is not quite an item read among nine others: label such coverage "subagent-simulated".
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatRequest, ChatResponse, Model } from "@eden/llm";

/** One item's answer: the card the model would write for it (without `i`), or null for kind none, and its requests. */
export interface ItemAnswer {
  key: string;
  card: Record<string, unknown> | null;
  q: string[];
}

/** What a pending file holds: the item's block as the prompt fenced it (`i` dropped), and the prompt's day. */
export interface PendingItem {
  key: string;
  today: string;
  block: string;
}

const ITEM = /<item i="(\d+)"([^>]*)>\n([\s\S]*?)\n<\/item>/g;

/** The items of a card or requests-only prompt, in order: index, the block without its index, and the item's key. */
export function promptItems(req: ChatRequest): { i: number; block: string; key: string; today: string }[] {
  const system = req.messages.find((m) => m.role === "system")?.content ?? "";
  const user = req.messages.find((m) => m.role === "user")?.content ?? "";
  const today = /Today is (\d{4}-\d{2}-\d{2})/.exec(system)?.[1] ?? "";
  return [...user.matchAll(ITEM)].map((m) => {
    const block = `<item${m[2]}>\n${m[3]}\n</item>`;
    const key = createHash("sha256").update(`${today}\n${block}`).digest("hex").slice(0, 24);
    return { i: Number(m[1]), block, key, today };
  });
}

/** Whether the prompt is the requests-only re-ask (`requestMessages`), and whether a card prompt asks for requests. */
export function promptShape(req: ChatRequest): { requestsOnly: boolean; intent: boolean } {
  const system = req.messages.find((m) => m.role === "system")?.content ?? "";
  const requestsOnly = !system.includes("Kinds:");
  return { requestsOnly, intent: requestsOnly || system.includes('Put them in "requests"') };
}

/** The reply a model would give for these items: the card call's JSON (or the re-ask's requests only). */
export function composeReply(
  items: { i: number; key: string }[],
  answers: ReadonlyMap<string, ItemAnswer>,
  shape: { requestsOnly: boolean; intent: boolean },
): string {
  const cards = items.flatMap(({ i, key }) => {
    const card = answers.get(key)?.card;
    return card && card.kind !== "none" ? [{ i, ...card }] : [];
  });
  const requests = items.map(({ i, key }) => ({ i, q: answers.get(key)?.q ?? [] }));
  if (shape.requestsOnly) return JSON.stringify({ requests });
  return JSON.stringify(shape.intent ? { cards, requests } : { cards });
}

/** Every answer under `dir/answers` (later lines win), checked for shape. */
export function readAnswers(dir: string): Map<string, ItemAnswer> {
  const out = new Map<string, ItemAnswer>();
  const at = join(dir, "answers");
  if (!existsSync(at)) return out;
  for (const f of readdirSync(at).sort()) {
    if (!f.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(at, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const a = JSON.parse(line) as Partial<ItemAnswer>;
      if (typeof a.key !== "string") throw new Error(`${f}: an answer without a key`);
      const card = a.card && typeof a.card === "object" ? (a.card as Record<string, unknown>) : null;
      const q = Array.isArray(a.q) ? a.q.filter((s): s is string => typeof s === "string") : [];
      out.set(a.key, { key: a.key, card, q });
    }
  }
  return out;
}

/**
 * The queue model: answers a call whose every item has an answer, else writes the missing items to `dir/pending` and
 * throws. The system prompt of each shape is kept once (`dir/system-<shape>.txt`) for the subagents' brief.
 */
export function queueModel(dir: string, answers: ReadonlyMap<string, ItemAnswer> = readAnswers(dir)): Model {
  mkdirSync(join(dir, "pending"), { recursive: true });
  return {
    id: "subagent-queue",
    chat: async (req): Promise<ChatResponse> => {
      const items = promptItems(req);
      const shape = promptShape(req);
      const name = shape.requestsOnly ? "requests" : shape.intent ? "cards-intent" : "cards";
      const sysFile = join(dir, `system-${name}.txt`);
      if (!existsSync(sysFile)) writeFileSync(sysFile, req.messages.find((m) => m.role === "system")?.content ?? "");
      const missing = items.filter((it) => !answers.has(it.key));
      if (missing.length) {
        for (const it of missing) {
          const p: PendingItem = { key: it.key, today: it.today, block: it.block };
          writeFileSync(join(dir, "pending", `${it.key}.json`), JSON.stringify(p));
        }
        throw new Error(`subagent queue: ${missing.length} of ${items.length} items unanswered`);
      }
      const text = composeReply(items, answers, shape);
      const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      return { text, usage, costUsd: 0, model: "subagent-queue", latencyMs: 0 };
    },
  };
}
