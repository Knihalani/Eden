/**
 * Miss-when-needed A/B: default inject vs EDEN_MEMORY_X=aurora.
 * No NVIDIA. Product default stays off. Fail-open. Not BrainMemory.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../../packages/cli/src/memory-hook";
import { putExperience } from "../../src/experience-store";
import { MEMORY_MARK, openMemory } from "../../src/index";

export type Arm = "default" | "aurora";

export type CaseRow = {
  id: string;
  gold: string[];
  wantSilent?: boolean;
  defaultHit: boolean;
  auroraHit: boolean;
  defaultSilent: boolean;
  auroraSilent: boolean;
  defaultBytes: number;
  auroraBytes: number;
};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "eden-x-"));
}

export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function packetOf(injected: unknown[]): string {
  return JSON.stringify(injected);
}

function armEnv(arm: Arm, dir: string): Record<string, string | undefined> {
  return {
    EDEN_MEMORY_DIR: dir,
    EDEN_MEMORY: "on",
    EDEN_KNOW: "0",
    EDEN_HOME: undefined,
    EDEN_MEMORY_X: arm === "aurora" ? "aurora" : undefined,
    EDEN_MEMORY_MIN: undefined,
  };
}

async function scoreInject(arm: Arm, dir: string, seed: (mem: ReturnType<typeof openMemory>) => void | Promise<void>, cue: string, gold: string[]): Promise<{ hit: boolean; silent: boolean; bytes: number; body: string }> {
  return withEnv(armEnv(arm, dir), async () => {
    const mem = openMemory({ dir });
    try {
      await seed(mem);
      const out = mem.inject([{ role: "user", content: cue }]);
      const body = packetOf(out);
      const silent = !body.includes(MEMORY_MARK);
      const hit = gold.every((g) => new RegExp(g, "i").test(body));
      return { hit, silent, bytes: body.length, body };
    } finally {
      try { mem.close(); } catch {}
    }
  });
}

export async function runAmbitiousCases(): Promise<CaseRow[]> {
  const rows: CaseRow[] = [];

  const add = async (id: string, gold: string[], wantSilent: boolean, seed: (dir: string) => Promise<{ hit: boolean; silent: boolean; bytes: number }>, cueRun: (arm: Arm, dir: string) => Promise<{ hit: boolean; silent: boolean; bytes: number }>) => {
    const d = tmp();
    const a = tmp();
    try {
      const def = await cueRun("default", d);
      const aur = await cueRun("aurora", a);
      void seed;
      rows.push({
        id,
        gold,
        wantSilent,
        defaultHit: def.hit,
        auroraHit: aur.hit,
        defaultSilent: def.silent,
        auroraSilent: aur.silent,
        defaultBytes: def.bytes,
        auroraBytes: aur.bytes,
      });
    } finally {
      rmSync(d, { recursive: true, force: true });
      rmSync(a, { recursive: true, force: true });
    }
  };

  await add("H1-paraphrase-login-clerk", ["Clerk"], false, async () => ({ hit: false, silent: false, bytes: 0 }), async (arm, dir) =>
    scoreInject(arm, dir, (mem) => { mem.observe([{ role: "user", content: "Auth is Clerk." }]); }, "why is login broken?", ["Clerk"]));

  await add("H2-math-still-silent", [], true, async () => ({ hit: false, silent: false, bytes: 0 }), async (arm, dir) =>
    scoreInject(arm, dir, (mem) => { mem.observe([{ role: "user", content: "Always use sqlite." }]); }, "what's 2+2?", ["sqlite"]));

  await add("H3-long-prompt-one-auth", ["Clerk"], false, async () => ({ hit: false, silent: false, bytes: 0 }), async (arm, dir) =>
    scoreInject(arm, dir, (mem) => { mem.observe([{ role: "user", content: "Auth is Clerk." }]); },
      "please look at the middleware and the session helper and tell me if auth is wired the way we wanted for the new dashboard rewrite",
      ["Clerk"]));

  await add("H4-who-owns-flake", ["auth.test"], false, async () => ({ hit: false, silent: false, bytes: 0 }), async (arm, dir) =>
    scoreInject(arm, dir, (mem) => {
      mem.observe([{ role: "user", content: "Please fix the flake in auth.test.ts. FAIL auth.test.ts Intermittent flake on login." }]);
    }, "who owns the flake?", ["auth.test"]));

  await add("H5-two-golds-one-cue", ["Clerk", "sqlite"], false, async () => ({ hit: false, silent: false, bytes: 0 }), async (arm, dir) =>
    scoreInject(arm, dir, (mem) => {
      mem.observe([{ role: "user", content: "Auth is Clerk." }]);
      mem.observe([{ role: "user", content: "The database is sqlite." }]);
    }, "what stack do we use for login and the db?", ["Clerk", "sqlite"]));

  await add("H6-new-session-after-sleep", ["sqlite"], false, async () => ({ hit: false, silent: false, bytes: 0 }), async (arm, dir) => {
    return withEnv(armEnv(arm, dir), async () => {
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: "The database is sqlite." }]);
      await mem.sleep();
      mem.close();
      const b = openMemory({ dir, session: "sess-b" });
      const out = b.inject([{ role: "user", content: "what database do we use" }]);
      b.close();
      const body = packetOf(out);
      return { hit: /sqlite/i.test(body), silent: !body.includes(MEMORY_MARK), bytes: body.length, body };
    });
  });

  await add("H7-hook-new-session", ["sqlite"], false, async () => ({ hit: false, silent: false, bytes: 0 }), async (arm, dir) => {
    return withEnv(armEnv(arm, dir), async () => {
      memoryHookResponse({
        hook_event_name: "Stop",
        session_id: "xa",
        messages: [{ role: "user", content: "The database is sqlite." }],
      });
      const res = memoryHookResponse({
        hook_event_name: "UserPromptSubmit",
        session_id: "xb",
        prompt: "what database do we use",
      });
      const body = String(res?.additional_context ?? "");
      return { hit: /sqlite/i.test(body), silent: !body.includes(MEMORY_MARK), bytes: body.length };
    });
  });

  await add("H8-wrap-then-hook-cwd", ["sqlite"], false, async () => ({ hit: false, silent: false, bytes: 0 }), async (arm, dir) => {
    return withEnv(armEnv(arm, dir), async () => {
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: "The database is sqlite." }]);
      mem.close();
      const res = memoryHookResponse({
        hook_event_name: "UserPromptSubmit",
        prompt: "what database do we use",
        cwd: "/tmp/eden-x-project-path",
      });
      const body = String(res?.additional_context ?? "");
      return { hit: /sqlite/i.test(body), silent: !body.includes(MEMORY_MARK), bytes: body.length };
    });
  });

  await add("H9-encode-drop", ["Clerk"], false, async () => ({ hit: false, silent: false, bytes: 0 }), async (arm, dir) =>
    scoreInject(arm, dir, (mem) => { mem.observe([{ role: "user", content: "Pin Clerk in the session helper" }]); }, "what auth do we use", ["Clerk"]));

  await add("H10-experience-thought", ["GOLDNEEDLE-zz9"], false, async () => ({ hit: false, silent: false, bytes: 0 }), async (arm, dir) => {
    return withEnv(armEnv(arm, dir), async () => {
      putExperience(dir, {
        id: "traj-x1",
        states: [{
          t: 1,
          thought: "the user wanted GOLDNEEDLE-zz9 on the change-request form",
          action: "click submit",
          tree: "RootWebArea [landmark] heading UnrelatedAX",
        }],
      });
      const mem = openMemory({ dir });
      const out = mem.inject([{ role: "user", content: "what was on the change-request form" }]);
      mem.close();
      const body = packetOf(out);
      return { hit: /GOLDNEEDLE-zz9/i.test(body), silent: !body.includes(MEMORY_MARK), bytes: body.length };
    });
  });

  await add("H11-chatter-thanks", [], true, async () => ({ hit: false, silent: false, bytes: 0 }), async (arm, dir) =>
    scoreInject(arm, dir, (mem) => { mem.observe([{ role: "user", content: "Auth is Clerk." }]); }, "thanks", ["Clerk"]));

  await add("H12-fat-many-auth", ["alpha", "omega"], false, async () => ({ hit: false, silent: false, bytes: 0 }), async (arm, dir) =>
    scoreInject(arm, dir, (mem) => {
      for (const n of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "omega"]) {
        mem.observe([{ role: "user", content: `Auth note ${n} is required for the login stack.` }]);
      }
    }, "auth login stack notes", ["alpha", "omega"]));

  return rows;
}

export function renderAmbitiousResults(rows: CaseRow[]): string {
  const lines = [
    "# Ambitious memory retrieve A/B",
    "",
    `**Date:** ${new Date().toISOString().slice(0, 10)}`,
    "**API:** `openMemory` inject + hook Submit. Not BrainMemory. Not NVIDIA.",
    "**Control:** `EDEN_MEMORY_X` unset (today's product).",
    "**Treatment:** `EDEN_MEMORY_X=aurora` (cluster + ripple + union + identity + fat + mathsilent + nofilter).",
    "",
    "Hit = every gold needle in the inject packet. Silent = no `Eden Memory:` mark.",
    "",
    "| case | gold | default hit | aurora hit | default silent | aurora silent | Δ bytes |",
    "|---|---|---|---|---|---|---:|",
  ];
  for (const r of rows) {
    const dHit = r.wantSilent ? (r.defaultSilent ? "omit" : "LEAK") : (r.defaultHit ? "yes" : "MISS");
    const aHit = r.wantSilent ? (r.auroraSilent ? "omit" : "LEAK") : (r.auroraHit ? "yes" : "MISS");
    lines.push(`| ${r.id} | ${r.gold.join(", ") || "—"} | ${dHit} | ${aHit} | ${r.defaultSilent} | ${r.auroraSilent} | ${r.auroraBytes - r.defaultBytes} |`);
  }
  const need = rows.filter((r) => !r.wantSilent);
  const defN = need.filter((r) => r.defaultHit).length;
  const aurN = need.filter((r) => r.auroraHit).length;
  const silence = rows.filter((r) => r.wantSilent);
  const defS = silence.filter((r) => r.defaultSilent).length;
  const aurS = silence.filter((r) => r.auroraSilent).length;
  lines.push("");
  lines.push(`Needed-and-present: default **${defN}/${need.length}** → aurora **${aurN}/${need.length}**.`);
  lines.push(`Math/chatter omit: default **${defS}/${silence.length}** → aurora **${aurS}/${silence.length}**.`);
  lines.push("");
  lines.push("Did not retune LoCoMo / k=40 / Table 3. Default inject unchanged when the flag is unset.");
  return lines.join("\n") + "\n";
}

export async function runH1Ablation(): Promise<{ flag: string; hit: boolean; silent: boolean }[]> {
  const flags = ["", "cluster", "mathsilent", "identity", "ripple", "fat", "nofilter", "union", "aurora"];
  const out: { flag: string; hit: boolean; silent: boolean }[] = [];
  for (const flag of flags) {
    const dir = tmp();
    try {
      const r = await withEnv(
        {
          EDEN_MEMORY_DIR: dir,
          EDEN_MEMORY: "on",
          EDEN_KNOW: "0",
          EDEN_HOME: undefined,
          EDEN_MEMORY_X: flag || undefined,
        },
        () => {
          const mem = openMemory({ dir });
          mem.observe([{ role: "user", content: "Auth is Clerk." }]);
          const body = packetOf(mem.inject([{ role: "user", content: "why is login broken?" }]));
          mem.close();
          return { hit: /Clerk/i.test(body), silent: !body.includes(MEMORY_MARK) };
        },
      );
      out.push({ flag: flag || "default", ...r });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return out;
}
