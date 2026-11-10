#!/usr/bin/env bun
/**
 * The real-data pilot kit (F3, D489; docs/PILOT.md): one consenting account's own data and requests, on that person's
 * own machine, through the agent alone and the agent with Eden.
 *
 *   bun run pilot task add --id dentist --text "Book the dentist for Friday morning" --fact "Friday 9:00 clashes ..."
 *   bun run pilot import --sources sources.json --name "Ada Example" --email ada@example.com
 *   bun run pilot status
 *   bun run pilot run --model claude-haiku-5-5 --cap 0.50 --send-to anthropic
 *   bun run pilot annotate
 *   bun run pilot report
 *   bun run pilot forget
 *
 * What leaves the machine: the connectors' own reads during `import` (to the account's own provider), and during `run`
 * the model calls the owner names (`--send-to anthropic`: the agent's, Eden's cards and reader, the grader's), to
 * Anthropic's API under the owner's own key. Nothing else: no telemetry, no bench ledger, no git. Lab tooling.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { sanitizeForStore } from "@eden/redact";
import { checkSpecs, UserSources } from "@eden/server";
import type { Background, RunResult } from "../lab/ab-common";
import { importSources } from "./import";
import { annotate } from "./annotate";
import { buildReport, renderReport } from "./report";
import { pilotDir, PilotStore, type PilotTask } from "./store";

const USAGE = `pilot <command>   (files in EDEN_PILOT_DIR, default ~/.eden/pilot; never inside a git repository)
  task add --id ID --text "the request" [--fact "what mattered" ...]   a real request, and what mattered for it
  task list | task rm ID
  import --sources FILE --name "Full Name" --email ADDR [--max-items 2000] [--query "words" ...]
         FILE: a JSON array of source specs with presets, as one user's entry of EDEN_USER_SOURCES_FILE
  status                                  what is held
  run --model claude-… --cap USD --send-to anthropic [--run NAME] [--arms tools,eden] [--limit N]
  annotate [--run NAME]                   mark each answer without knowing its arm
  report [--run NAME]
  forget                                  delete everything the pilot wrote`;

/** The pilot's scope: one tenant, one user, never shared with a server's. */
const SCOPE = { tenantId: "pilot", userId: "owner" };
const LAB = join(import.meta.dir, "..", "lab");

interface Flags {
  one: Record<string, string>;
  many: Record<string, string[]>;
  rest: string[];
}

export function parseFlags(argv: readonly string[], repeatable: readonly string[] = []): Flags {
  const f: Flags = { one: {}, many: {}, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      f.rest.push(a);
      continue;
    }
    const name = a.slice(2);
    const value = argv[++i];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    if (repeatable.includes(name)) (f.many[name] ??= []).push(value);
    else f.one[name] = value;
  }
  return f;
}

const need = (f: Flags, name: string): string => {
  const v = f.one[name];
  if (!v) throw new Error(`--${name} is required`);
  return v;
};

/** The owner's facts, each with a short id of its own. */
export function newTask(id: string, text: string, facts: readonly string[], now: number): PilotTask {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id))
    throw new Error("--id is a short name: lower-case letters, digits, dashes");
  if (!text.trim()) throw new Error("--text is the request, in the words you would give an assistant");
  // The owner's own words are stored and sent to models too: they pass the gate like any stored text (D10).
  const safe = (t: string) => sanitizeForStore(t.trim());
  const kept = facts.map((detail, i) => ({ id: `${id}-${i + 1}`, detail: safe(detail) }));
  return { id, text: safe(text), facts: kept, addedAt: now };
}

/** A run's own headroom under its cap (as the fan-out's shards: a tenth, at most $0.25), not the ledger's $0.50. */
export const headroomFor = (cap: number) => Math.min(0.25, Math.round(cap * 1000) / 10_000);

/** The specs of a sources file; a file that is not JSON is named, never quoted (it may hold a token). */
export function readSpecs(file: string): ReturnType<typeof checkSpecs> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`cannot read ${file}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  return checkSpecs(raw, file);
}

/** What a run sends, and where: printed before anything is sent, and the run starts only with `--send-to` naming it. */
export function sendNotice(model: string, arms: readonly string[], items: number, tasks: number): string {
  return [
    `This run sends parts of your imported data to Anthropic's API (model ${model}, your own key):`,
    `  - the agent (${arms.join(", ")}): each of your ${tasks} requests, what its tools return and what Eden hands it;`,
    "  - Eden's background cards: the text of imported items it reads (up to all " + `${items} of them);`,
    "  - Eden's reader: a request and the candidate items for it;",
    "  - the grader: each answer and the facts you wrote for its request.",
    "Nothing goes anywhere else. Secrets the gate recognises were replaced with [REDACTED] at import.",
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  // Everything this process and the harness it starts create is owner-only.
  process.umask(0o077);
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "help") {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }
  const store = new PilotStore(pilotDir());
  const latestRun = (f: Flags) => f.one.run ?? "pilot";
  switch (cmd) {
    case "task": {
      const [sub, ...args] = rest;
      const tasks = store.tasks();
      if (sub === "list") {
        for (const t of tasks) console.log(`${t.id}: ${t.text}\n${t.facts.map((x) => `    - ${x.detail}`).join("\n")}`);
        console.log(`${tasks.length} requests, ${tasks.filter((t) => t.facts.length).length} with facts that mattered`);
        return 0;
      }
      if (sub === "rm") {
        store.saveTasks(tasks.filter((t) => t.id !== args[0]));
        return 0;
      }
      if (sub === "add") {
        const f = parseFlags(args, ["fact"]);
        const t = newTask(need(f, "id"), need(f, "text"), f.many.fact ?? [], Date.now());
        if (tasks.some((x) => x.id === t.id)) throw new Error(`a request named ${t.id} exists: task rm ${t.id} first`);
        store.saveTasks([...tasks, t]);
        console.log(`added ${t.id} (${t.facts.length} facts that mattered); ${tasks.length + 1} requests`);
        return 0;
      }
      throw new Error("task add | task list | task rm ID");
    }
    case "import": {
      const f = parseFlags(rest, ["query"]);
      const file = need(f, "sources");
      const specs = readSpecs(file);
      const user = { name: need(f, "name"), email: need(f, "email") };
      const sources = new UserSources({ directory: () => specs });
      try {
        const status = await sources.status(SCOPE);
        if (status.error) throw new Error(status.error);
        // The owner's requests are searched for too: a source with no listing is read only this way.
        const queries = [...store.tasks().map((t) => t.text), ...(f.many.query ?? [])];
        const got = await importSources(await sources.sources(SCOPE), SCOPE, user, {
          maxItems: f.one["max-items"] === undefined ? 2_000 : Number(f.one["max-items"]),
          queries,
          log: (l) => console.log(`  ${l}`),
        });
        store.saveImport(got.meta, got.items);
        const redacted = Object.values(got.meta.counts).reduce((s, c) => s + c.redacted, 0);
        console.log(`kept ${got.items.length} items in ${store.dir} (${redacted} had a secret redacted)`);
      } finally {
        sources.close();
      }
      return 0;
    }
    case "status": {
      const meta = store.meta();
      console.log(`pilot directory: ${store.dir}`);
      if (meta) {
        for (const [id, c] of Object.entries(meta.counts))
          console.log(`  ${id}: ${c.items} items, ${c.redacted} redacted`);
        console.log(`  imported ${new Date(meta.importedAt).toISOString()} for ${meta.user.name}`);
      } else console.log("  nothing imported");
      const tasks = store.tasks();
      console.log(
        `  ${tasks.length} requests (${tasks.filter((t) => t.facts.length).length} with facts that mattered)`,
      );
      return 0;
    }
    case "run": {
      const f = parseFlags(rest);
      const meta = store.meta();
      const tasks = store.tasks();
      if (!meta || !tasks.length) throw new Error("import first, and add at least one request (task add)");
      const model = need(f, "model");
      // Only Anthropic's own API: the lab's OpenRouter route does not pin the no-retention endpoints the servers use
      // (D12), so real data does not go that way from here.
      if (!model.startsWith("claude-")) throw new Error("--model must be a claude-* model (Anthropic's API, your key)");
      const cap = Number(need(f, "cap"));
      if (!(cap > 0)) throw new Error("--cap is the most this run may spend, in dollars");
      const arms = (f.one.arms ?? "tools,eden").split(",");
      const items = store.items();
      console.log(sendNotice(model, arms, items.length, tasks.length));
      if (f.one["send-to"] !== "anthropic") {
        console.log("\nNot started. Add --send-to anthropic to run it.");
        return 2;
      }
      const run = latestRun(f);
      const dir = store.runDir(run);
      // A run's answers are marked once: a second run under the same name would pair old marks with new answers.
      if (store.exists(store.runFile(run, "out.json"))) {
        throw new Error(`a run named ${run} exists: name another with --run NAME`);
      }
      store.write(store.runFile(run, "bundle.json"), JSON.stringify({ meta, items, tasks }));
      const out = join(dir, "out.json");
      const env = { ...process.env };
      delete env.OPENROUTER_API_KEY;
      const piAb = spawnSync(
        "bun",
        [
          join(LAB, "pi-ab.ts"),
          "--world-file",
          join(dir, "bundle.json"),
          ...["--conditions", arms.join(","), "--config", "default", "--push", "payload"],
          ...["--source-profile", join(LAB, "..", "..", "lab", "before-after", "market-profiles", "direct.json")],
          ...["--model", model, "--grader", model, "--card-model", model, "--reader-model", model],
          ...["--spend-ledger", join(dir, "ledger.jsonl"), "--spend-cap", String(cap), "--budget", String(cap)],
          ...["--spend-headroom", String(headroomFor(cap))],
          ...["--out", out, "--timeline", join(dir, "timeline"), "--cards-out", join(dir, "cards.jsonl")],
          ...["--run-label", `pilot-${run}`],
          ...(f.one.limit ? ["--limit", f.one.limit] : []),
        ],
        { env, stdio: "inherit" },
      );
      // The harness's own files (answers, timeline, ledger, cards) are narrowed to the owner as the store's are.
      store.lockRun(run);
      if (piAb.status !== 0) return piAb.status ?? 1;
      console.log(`\nanswers in ${out}. Next: pilot annotate${run === "pilot" ? "" : ` --run ${run}`}`);
      return 0;
    }
    case "annotate": {
      const f = parseFlags(rest);
      const run = latestRun(f);
      const results = JSON.parse(store.read(store.runFile(run, "out.json"))) as { results: RunResult[] };
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const marks = await annotate(store.tasks(), results.results, store.marks(run), {
          ask: (q) => rl.question(q),
          print: (l) => console.log(l),
          save: (m) => store.saveMarks(run, m),
        });
        console.log(`marks saved for ${Object.keys(marks).length} requests. Next: pilot report`);
      } finally {
        rl.close();
      }
      return 0;
    }
    case "report": {
      const f = parseFlags(rest);
      const run = latestRun(f);
      const out = JSON.parse(store.read(store.runFile(run, "out.json"))) as {
        results: RunResult[];
        background?: Background[];
      };
      const [alone, withEden] = (f.one.arms ?? "tools,eden").split(",");
      const report = buildReport(store.tasks(), out.results, store.marks(run), alone, withEden, out.background);
      const text = renderReport(report);
      store.write(store.runFile(run, "report.txt"), `${text}\n`);
      console.log(text);
      return 0;
    }
    case "forget":
      console.log(store.forget() ? `deleted ${store.dir}` : "nothing to delete");
      return 0;
    default:
      console.log(USAGE);
      return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      // Config and usage errors are messages, not stack traces, and pass the gate: a message may quote a URL or a
      // header from the owner's own files.
      console.error(`pilot: ${sanitizeForStore(e instanceof Error ? e.message : String(e)).slice(0, 400)}`);
      process.exit(2);
    },
  );
}
