import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hashTrace, type Manifest, type Refusal, type StretchProgram, type StretchTrace } from "@eden/ir";
import { openDb, type EdenDb } from "./db";

export type Candidate = {
  id: string;
  sequence: string[];
  program: StretchProgram | null;
  refusal: Refusal | null;
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE" | "pending";
  manifest: Manifest | null;
  created_at: number;
};

export type LiveTool = {
  id: string;
  name: string;
  version: string;
  program: StretchProgram;
  state: "live" | "paused" | "rolled_back";
  prev?: StretchProgram[] | StretchProgram | null;
  created_at: number;
  updated_at: number;
  /** Approve-time checkbox. Required (with EDEN_TRANSPARENT_WRITES) to serve Write. */
  transparent_writes?: boolean;
  /**
   * Serving stamp. Missing = live 100% (already-shipped tools stay fully on).
   * New Approve writes canary unless the body asked for live.
   */
  rollout?: "canary" | "live";
  /**
   * Who Approved this version: `x-eden-org` when the request carried one,
   * otherwise `"operator"`. Never a person name or email we invented.
   */
  approved_by?: string;
  /** Unix ms of Approve. Pause / promote must not rewrite this. */
  approved_at?: number;
};

export type StoredReceipt = {
  id: string;
  tool_id: string;
  version: string;
  ms: number;
  llm_calls: number;
  cents: number;
  ok: number;
  created_at: number;
  payload?: string | null;
};

/** One superseded compilation of a stretch, kept so candidates can be diffed against what they replace. */
export type StoredProgramVersion = {
  tool_id: string;
  version: string;
  program: StretchProgram;
  created_at: number;
};

/** Operator cron. Never inserted by Approve / compile / wrap-run. */
export type StoredSchedule = {
  id: string;
  tool_id: string;
  cron: string;
  input: string | null;
  last_tick: string | null;
  created_at: number;
};

function receiptIsEarlyDeopt(payload: string | null | undefined): boolean {
  if (!payload) return false;
  try {
    const extra = JSON.parse(payload) as { early?: unknown; outcome?: unknown };
    return extra.early === true || extra.outcome === "deopt";
  } catch {
    return false;
  }
}

export class Store {
  db: EdenDb;
  /** The embedded control plane serves one workspace; org bindings hang off it. */
  static WORKSPACE_ID = "ws_local";
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = openDb(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        hash TEXT
      );
      CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY,
        sequence TEXT NOT NULL,
        program TEXT,
        refusal TEXT,
        verdict TEXT NOT NULL,
        manifest TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tools (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        program TEXT NOT NULL,
        state TEXT NOT NULL,
        prev TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        flags TEXT
      );
      CREATE TABLE IF NOT EXISTS receipts (
        id TEXT PRIMARY KEY,
        tool_id TEXT NOT NULL,
        version TEXT NOT NULL,
        ms REAL NOT NULL,
        llm_calls INTEGER NOT NULL,
        cents REAL NOT NULL,
        ok INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_orgs (
        workspace_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, org_id)
      );
      CREATE TABLE IF NOT EXISTS program_versions (
        tool_id TEXT NOT NULL,
        version TEXT NOT NULL,
        program TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (tool_id, version)
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        tool_id TEXT NOT NULL UNIQUE,
        cron TEXT NOT NULL,
        input TEXT,
        last_tick TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schedule_ticks (
        tool_id TEXT NOT NULL,
        tick TEXT NOT NULL,
        PRIMARY KEY (tool_id, tick)
      );
      CREATE INDEX IF NOT EXISTS traces_created ON traces(created_at);
      CREATE INDEX IF NOT EXISTS receipts_tool ON receipts(tool_id, created_at);
      CREATE INDEX IF NOT EXISTS tools_state ON tools(state);
      CREATE INDEX IF NOT EXISTS candidates_created ON candidates(created_at);
      CREATE INDEX IF NOT EXISTS program_versions_tool ON program_versions(tool_id, created_at);
    `);
    try {
      this.db.exec(`ALTER TABLE traces ADD COLUMN hash TEXT`);
    } catch {
      /* already present */
    }
    try {
      this.db.exec(`ALTER TABLE receipts ADD COLUMN payload TEXT`);
    } catch {
      /* already present */
    }
    try {
      this.db.exec(`ALTER TABLE tools ADD COLUMN flags TEXT`);
    } catch {
      /* already present */
    }
    try {
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS traces_hash ON traces(hash)`);
    } catch {
      /* duplicate hashes on migrate — still usable */
    }
  }

  private gate: Promise<void> = Promise.resolve();

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gate.then(fn, fn);
    this.gate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  putTrace(t: StretchTrace): boolean {
    const hash = hashTrace(t);
    const hit = this.db.query(`SELECT id FROM traces WHERE hash = ?`).get(hash) as { id: string } | null;
    if (hit) return false;
    try {
      this.db.run(`INSERT OR REPLACE INTO traces (id, payload, created_at, hash) VALUES (?, ?, ?, ?)`, [
        t.id || hash.slice(0, 16),
        JSON.stringify(t),
        Date.now(),
        hash,
      ]);
    } catch {
      return false;
    }
    const n = (this.db.query(`SELECT COUNT(*) as n FROM traces`).get() as { n: number }).n;
    if (n > 5000) {
      this.db.run(`DELETE FROM traces WHERE id IN (SELECT id FROM traces ORDER BY created_at ASC LIMIT ?)`, [n - 5000]);
    }
    return true;
  }

  /**
   * Late proxy usage for a stretch we already stored unmeasured.
   * Hash ignores tokens, so a re-post would otherwise be a duplicate forever.
   */
  sealUnmeasured(sealed: StretchTrace): boolean {
    const hash = hashTrace(sealed);
    const row = this.db.query(`SELECT id, payload FROM traces WHERE hash = ?`).get(hash) as {
      id: string;
      payload: string;
    } | null;
    if (!row) return false;
    let current: StretchTrace;
    try {
      current = JSON.parse(row.payload) as StretchTrace;
    } catch {
      return false;
    }
    if (current.prompt_tokens != null) return false;
    if (sealed.prompt_tokens == null && sealed.llmCalls === current.llmCalls && sealed.output === current.output) {
      return false;
    }
    const next: StretchTrace = {
      ...current,
      llmCalls: sealed.llmCalls || current.llmCalls,
      output: current.output ?? sealed.output,
      ...(sealed.prompt_tokens != null
        ? { prompt_tokens: sealed.prompt_tokens, completion_tokens: sealed.completion_tokens }
        : {}),
    };
    this.db.run(`UPDATE traces SET payload = ? WHERE id = ?`, [JSON.stringify(next), row.id]);
    return true;
  }

  inboxSig(): string {
    const cands = this.candidates()
      .map((c) => `${c.id}:${c.verdict}:${c.refusal ? "r" : "p"}`)
      .join(",");
    const tools = this.tools()
      .map((t) => `${t.id}:${t.state}:${t.updated_at}`)
      .join(",");
    const counts = `${this.tracesCount()}|${this.liveCount()}|${this.receiptsCount()}|${this.lastHeartbeat()}`;
    return `${counts}|${cands}|${tools}`;
  }

  traces(): StretchTrace[] {
    return this.db
      .query(`SELECT payload FROM traces ORDER BY created_at`)
      .all()
      .flatMap((r) => {
        try {
          return [JSON.parse((r as { payload: string }).payload) as StretchTrace];
        } catch {
          return [];
        }
      });
  }

  tracesCount(): number {
    return (this.db.query(`SELECT COUNT(*) as n FROM traces`).get() as { n: number }).n;
  }

  candidatesCount(): number {
    return (this.db.query(`SELECT COUNT(*) as n FROM candidates`).get() as { n: number }).n;
  }

  liveCount(): number {
    return (this.db.query(`SELECT COUNT(*) as n FROM tools WHERE state = 'live'`).get() as { n: number }).n;
  }

  receiptsCount(): number {
    return (this.db.query(`SELECT COUNT(*) as n FROM receipts`).get() as { n: number }).n;
  }

  schedulesCount(): number {
    return (this.db.query(`SELECT COUNT(*) as n FROM schedules`).get() as { n: number }).n;
  }

  failsCount(): number {
    return (this.db.query(`SELECT COUNT(*) as n FROM receipts WHERE ok = 0`).get() as { n: number }).n;
  }

  putCandidate(c: Candidate): void {
    this.db.run(
      `INSERT OR REPLACE INTO candidates (id, sequence, program, refusal, verdict, manifest, created_at) VALUES (?,?,?,?,?,?,?)`,
      [
        c.id,
        JSON.stringify(c.sequence),
        c.program ? JSON.stringify(c.program) : null,
        c.refusal ? JSON.stringify(c.refusal) : null,
        c.verdict,
        c.manifest ? JSON.stringify(c.manifest) : null,
        c.created_at,
      ],
    );
  }

  candidates(): Candidate[] {
    return this.db.query(`SELECT * FROM candidates ORDER BY created_at DESC`).all().map(rowToCandidate);
  }

  candidate(id: string): Candidate | undefined {
    const row = this.db.query(`SELECT * FROM candidates WHERE id = ?`).get(id);
    return row ? rowToCandidate(row) : undefined;
  }

  putTool(t: LiveTool): void {
    // Version history: when this write replaces a different compilation of the
    // same stretch, park the superseded program here first. Re-mining a
    // stretch updates its tool in place, so without this the previous
    // compilation would be gone and reviewers could not be shown what a new
    // candidate changes. Rows are scoped by tool_id, so two stretches never
    // see each other's versions.
    const existing = this.db.query(`SELECT version, program, updated_at FROM tools WHERE id = ?`).get(t.id) as {
      version: string;
      program: string;
      updated_at: number;
    } | null;
    if (existing && existing.version !== t.version) {
      this.recordProgramVersion(t.id, existing.version, existing.program, Number(existing.updated_at));
    }
    this.db.run(
      `INSERT OR REPLACE INTO tools (id, name, version, program, state, prev, created_at, updated_at, flags) VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        t.id,
        t.name,
        t.version,
        JSON.stringify(t.program),
        t.state,
        t.prev ? JSON.stringify(t.prev) : null,
        t.created_at,
        t.updated_at,
        toolFlagsJson(t),
      ],
    );
  }

  /** How many superseded compilations to keep per tool id. */
  static PROGRAM_VERSION_HISTORY = 5;

  private recordProgramVersion(toolId: string, version: string, programJson: string, at?: number): void {
    try {
      const prev = this.db
        .query(`SELECT created_at FROM program_versions WHERE tool_id = ? AND version = ?`)
        .get(toolId, version) as { created_at: number } | null;
      const kept = Number(prev?.created_at);
      const stamped = Number(at);
      const created =
        Number.isFinite(kept) && kept > 0
          ? Math.round(kept)
          : Number.isFinite(stamped) && stamped > 0
            ? Math.round(stamped)
            : Date.now();
      this.db.run(`INSERT OR REPLACE INTO program_versions (tool_id, version, program, created_at) VALUES (?,?,?,?)`, [
        toolId,
        version,
        programJson,
        created,
      ]);
      const keep = Store.PROGRAM_VERSION_HISTORY;
      this.db.run(
        `DELETE FROM program_versions WHERE tool_id = ? AND version NOT IN (
           SELECT version FROM program_versions WHERE tool_id = ? ORDER BY created_at DESC, version DESC LIMIT ?
         )`,
        [toolId, toolId, keep],
      );
    } catch {
      /* history is best-effort; never block a ship on it */
    }
  }

  /** Superseded compilations for one tool, newest first. Empty for a tool that was never replaced. */
  programVersions(toolId: string): StoredProgramVersion[] {
    return this.db
      .query(`SELECT * FROM program_versions WHERE tool_id = ? ORDER BY created_at DESC`)
      .all(toolId)
      .flatMap((row) => {
        const r = row as Record<string, string | number | null>;
        try {
          return [
            {
              tool_id: String(r.tool_id),
              version: String(r.version),
              program: JSON.parse(String(r.program)) as StretchProgram,
              created_at: Number(r.created_at),
            },
          ];
        } catch {
          return [];
        }
      });
  }

  tools(): LiveTool[] {
    return this.db.query(`SELECT * FROM tools ORDER BY updated_at DESC`).all().map(rowToTool);
  }

  livePrograms(): StretchProgram[] {
    return this.tools()
      .filter((t) => t.state === "live")
      .map((t) => t.program);
  }

  tool(id: string): LiveTool | undefined {
    const row = this.db.query(`SELECT * FROM tools WHERE id = ?`).get(id);
    return row ? rowToTool(row) : undefined;
  }

  clearCandidates(): void {
    this.db.run(`DELETE FROM candidates`);
  }

  deleteCandidate(id: string): boolean {
    const before = this.db.query(`SELECT id FROM candidates WHERE id = ?`).get(id);
    if (!before) return false;
    this.db.run(`DELETE FROM candidates WHERE id = ?`, [id]);
    return true;
  }

  putReceipt(r: Omit<StoredReceipt, "id" | "created_at"> & { id?: string; created_at?: number }): void {
    const created =
      Number.isFinite(r.created_at) && (r.created_at as number) > 0 ? Math.round(r.created_at as number) : Date.now();
    this.db.run(
      `INSERT INTO receipts (id, tool_id, version, ms, llm_calls, cents, ok, created_at, payload) VALUES (?,?,?,?,?,?,?,?,?)`,
      [r.id ?? crypto.randomUUID(), r.tool_id, r.version, r.ms, r.llm_calls, r.cents, r.ok, created, r.payload ?? null],
    );
    const n = (this.db.query(`SELECT COUNT(*) as n FROM receipts`).get() as { n: number }).n;
    if (n > 5000) {
      this.db.run(`DELETE FROM receipts WHERE id IN (SELECT id FROM receipts ORDER BY created_at ASC LIMIT ?)`, [
        n - 5000,
      ]);
    }
    this.maybeAutoPause(r.tool_id);
  }

  /** Failed compiled tools don’t keep running (44). Early deopts are not fails. */
  maybeAutoPause(toolId: string): void {
    const rows = this.receiptsFor(toolId);
    if (rows.length < 4) return;
    const hard = rows.filter((r) => r.ok === 0 && !receiptIsEarlyDeopt(r.payload)).length;
    if (hard / rows.length < 0.5) return;
    const t = this.tool(toolId);
    if (!t || t.state !== "live") return;
    t.state = "paused";
    t.updated_at = Date.now();
    this.putTool(t);
  }

  receipts(): StoredReceipt[] {
    return this.db.query(`SELECT * FROM receipts ORDER BY created_at DESC`).all() as StoredReceipt[];
  }

  receiptsFor(toolId: string): StoredReceipt[] {
    return this.db
      .query(`SELECT * FROM receipts WHERE tool_id = ? ORDER BY created_at DESC`)
      .all(toolId) as StoredReceipt[];
  }

  putSchedule(s: StoredSchedule): void {
    this.db.run(
      `INSERT OR REPLACE INTO schedules (id, tool_id, cron, input, last_tick, created_at) VALUES (?,?,?,?,?,?)`,
      [s.id, s.tool_id, s.cron, s.input, s.last_tick, s.created_at],
    );
  }

  scheduleFor(toolId: string): StoredSchedule | undefined {
    const row = this.db.query(`SELECT * FROM schedules WHERE tool_id = ?`).get(toolId) as StoredSchedule | null;
    return row ? rowToSchedule(row) : undefined;
  }

  schedules(): StoredSchedule[] {
    return this.db.query(`SELECT * FROM schedules ORDER BY created_at`).all().map(rowToSchedule);
  }

  deleteSchedule(toolId: string): boolean {
    const before = this.db.query(`SELECT id FROM schedules WHERE tool_id = ?`).get(toolId);
    if (!before) return false;
    this.db.run(`DELETE FROM schedules WHERE tool_id = ?`, [toolId]);
    this.db.run(`DELETE FROM schedule_ticks WHERE tool_id = ?`, [toolId]);
    return true;
  }

  /**
   * Claim one UTC-minute window for a tool. INSERT OR IGNORE on the primary
   * key: a second tick in the same window returns false and writes nothing.
   * Paused skips must not call this — resume can still fire that minute.
   */
  claimScheduleTick(toolId: string, tick: string): boolean {
    const claimed = this.db.run(`INSERT OR IGNORE INTO schedule_ticks (tool_id, tick) VALUES (?, ?)`, [toolId, tick]);
    if (claimed.changes === 0) return false;
    this.db.run(`UPDATE schedules SET last_tick = ? WHERE tool_id = ?`, [tick, toolId]);
    return true;
  }

  receiptStats(toolId: string): { n: number; ms: number; llm: number; cents: number; fail: number } {
    const row = this.db
      .query(
        `SELECT COUNT(*) as n, COALESCE(SUM(ms),0) as ms, COALESCE(SUM(llm_calls),0) as llm, COALESCE(SUM(cents),0) as cents, COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END),0) as fail FROM receipts WHERE tool_id = ?`,
      )
      .get(toolId) as { n: number; ms: number; llm: number; cents: number; fail: number } | null;
    return row ?? { n: 0, ms: 0, llm: 0, cents: 0, fail: 0 };
  }

  heartbeat(): void {
    this.db.run(`INSERT OR REPLACE INTO meta (k, v) VALUES ('heartbeat', ?)`, [String(Date.now())]);
  }

  /**
   * Bind a Clerk org to this workspace. Writes only happen through the
   * authenticated /v1/workspace/orgs route, and that route refuses to add an
   * org to a workspace already bound to a different one — otherwise any
   * authenticated member of any org could claim tenant access after the fact.
   *
   * The claim itself is atomic: a single INSERT … SELECT … WHERE NOT EXISTS
   * inside an IMMEDIATE transaction, so two processes sharing this database
   * file cannot both read "no binding yet" and each write their own org (the
   * first-bind TOCTOU — the read-then-write check in the route cannot close
   * it, because the read and the write are separate statements). Returns
   * "bound" when this call created the first binding, "exists" when the
   * requested org already holds the workspace (idempotent re-bind), and
   * "conflict" when a different org won the race or got there first.
   */
  bindOrg(workspaceId: string, orgId: string): "bound" | "exists" | "conflict" {
    this.db.exec(`BEGIN IMMEDIATE`);
    try {
      const claim = this.db.run(
        `INSERT INTO workspace_orgs (workspace_id, org_id, created_at)
         SELECT ?, ?, ? WHERE NOT EXISTS (
           SELECT 1 FROM workspace_orgs WHERE workspace_id = ?
         )`,
        [workspaceId, orgId, Date.now(), workspaceId],
      );
      const result = claim.changes > 0 ? "bound" : this.orgsFor(workspaceId).includes(orgId) ? "exists" : "conflict";
      this.db.exec(`COMMIT`);
      return result;
    } catch (err) {
      try {
        this.db.exec(`ROLLBACK`);
      } catch {
        /* transaction already unwound */
      }
      throw err;
    }
  }

  /** Every org allowed to drive state changes on this workspace. */
  orgsFor(workspaceId: string): string[] {
    return this.db
      .query(`SELECT org_id FROM workspace_orgs WHERE workspace_id = ? ORDER BY created_at`)
      .all(workspaceId)
      .map((r) => String((r as { org_id: string }).org_id));
  }

  lastHeartbeat(): number {
    const row = this.db.query(`SELECT v FROM meta WHERE k = 'heartbeat'`).get() as { v: string } | null;
    return row ? Number(row.v) : 0;
  }

  compiledCount(): number {
    const row = this.db.query(`SELECT v FROM meta WHERE k = 'compiled_n'`).get() as { v: string } | null;
    return row ? Number(row.v) : 0;
  }

  setCompiledCount(n: number): void {
    this.db.run(`INSERT OR REPLACE INTO meta (k, v) VALUES ('compiled_n', ?)`, [String(n)]);
  }

  savings(): {
    runs: number;
    fail: number;
    llmReductionMean: number;
    tokensSavedMean: number;
    timeSavedMsMean: number;
    live: number;
  } {
    const live = this.tools().filter((t) => t.state === "live");
    let runs = 0;
    let fail = 0;
    let red = 0;
    let tok = 0;
    let time = 0;
    let withM = 0;
    let withTok = 0;
    let withTime = 0;
    for (const t of live) {
      const stats = this.receiptStats(t.id);
      runs += stats.n;
      fail += stats.fail;
      const m = t.program.manifest;
      if (m?.llmReduction && Number.isFinite(m.llmReduction)) {
        red += m.llmReduction;
        withM++;
      }
      if (m?.tokensMeasured && m.tokensSaved != null && Number.isFinite(m.tokensSaved)) {
        tok += m.tokensSaved;
        withTok++;
      }
      if (m?.timeMeasured && m.timeSavedMs != null && Number.isFinite(m.timeSavedMs)) {
        time += m.timeSavedMs;
        withTime++;
      }
    }
    return {
      runs,
      fail,
      llmReductionMean: withM ? red / withM : 0,
      tokensSavedMean: withTok ? tok / withTok : 0,
      timeSavedMsMean: withTime ? time / withTime : 0,
      live: live.length,
    };
  }
}

function rowToSchedule(row: unknown): StoredSchedule {
  const r = row as Record<string, string | number | null>;
  return {
    id: String(r.id),
    tool_id: String(r.tool_id),
    cron: String(r.cron),
    input: r.input == null ? null : String(r.input),
    last_tick: r.last_tick == null ? null : String(r.last_tick),
    created_at: Number(r.created_at),
  };
}

function rowToCandidate(row: unknown): Candidate {
  const r = row as Record<string, string | number | null>;
  const parse = <T>(raw: string | number | null | undefined, fallback: T): T => {
    if (raw == null) return fallback;
    try {
      return JSON.parse(String(raw)) as T;
    } catch {
      return fallback;
    }
  };
  return {
    id: String(r.id),
    sequence: parse(r.sequence, []),
    program: r.program ? parse(r.program, null) : null,
    refusal: r.refusal ? parse(r.refusal, null) : null,
    verdict: r.verdict as Candidate["verdict"],
    manifest: r.manifest ? parse(r.manifest, null) : null,
    created_at: Number(r.created_at),
  };
}

function parsePrev(raw: string | number | null | undefined): StretchProgram[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(String(raw)) as unknown;
    if (Array.isArray(v)) return v as StretchProgram[];
    if (v && typeof v === "object") return [v as StretchProgram];
  } catch {
    /* ignore */
  }
  return [];
}

export function pushPrev(existing: LiveTool | undefined): StretchProgram[] {
  if (!existing) return [];
  const stack = Array.isArray(existing.prev) ? existing.prev : existing.prev ? [existing.prev] : [];
  return [existing.program, ...stack].slice(0, 8);
}

function rowToTool(row: unknown): LiveTool {
  const r = row as Record<string, string | number | null>;
  let program: StretchProgram;
  try {
    program = JSON.parse(String(r.program)) as StretchProgram;
  } catch {
    program = {
      id: String(r.id),
      version: String(r.version),
      name: String(r.name),
      description: "",
      inputSchema: { type: "object" },
      steps: [],
      returns: { kind: "literal", value: null },
      contract: { witnesses: 0, minLlmReduction: 2, allowExact: false },
      manifest: null,
    };
  }
  let flags: { transparent_writes?: boolean; rollout?: string; approved_by?: string; approved_at?: number } = {};
  try {
    if (r.flags)
      flags = JSON.parse(String(r.flags)) as {
        transparent_writes?: boolean;
        rollout?: string;
        approved_by?: string;
        approved_at?: number;
      };
  } catch {
    flags = {};
  }
  const approvedBy = typeof flags.approved_by === "string" ? flags.approved_by.trim() : "";
  const approvedAt = Number(flags.approved_at);
  return {
    id: String(r.id),
    name: String(r.name),
    version: String(r.version),
    program,
    state: r.state as LiveTool["state"],
    prev: parsePrev(r.prev),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
    ...(flags.transparent_writes === true ? { transparent_writes: true } : {}),
    ...(flags.rollout === "canary" || flags.rollout === "live" ? { rollout: flags.rollout } : {}),
    ...(approvedBy ? { approved_by: approvedBy } : {}),
    ...(Number.isFinite(approvedAt) && approvedAt > 0 ? { approved_at: Math.round(approvedAt) } : {}),
  };
}

/** Persist serving flags together — writing one must not wipe the others. */
export function toolFlagsJson(
  t: Pick<LiveTool, "transparent_writes" | "rollout" | "approved_by" | "approved_at">,
): string | null {
  const flags: {
    transparent_writes?: boolean;
    rollout?: "canary" | "live";
    approved_by?: string;
    approved_at?: number;
  } = {};
  if (t.transparent_writes === true) flags.transparent_writes = true;
  if (t.rollout === "canary" || t.rollout === "live") flags.rollout = t.rollout;
  const who = typeof t.approved_by === "string" ? t.approved_by.trim() : "";
  if (who) flags.approved_by = who;
  const at = Number(t.approved_at);
  if (Number.isFinite(at) && at > 0) flags.approved_at = Math.round(at);
  return Object.keys(flags).length ? JSON.stringify(flags) : null;
}
