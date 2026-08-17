import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hashTrace, type Manifest, type Refusal, type StretchProgram, type StretchTrace } from "@eden/ir";

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
};

export class Store {
  db: Database;
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
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
        updated_at INTEGER NOT NULL
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
      CREATE INDEX IF NOT EXISTS traces_created ON traces(created_at);
      CREATE INDEX IF NOT EXISTS receipts_tool ON receipts(tool_id, created_at);
      CREATE INDEX IF NOT EXISTS tools_state ON tools(state);
      CREATE INDEX IF NOT EXISTS candidates_created ON candidates(created_at);
    `);
    try {
      this.db.exec(`ALTER TABLE traces ADD COLUMN hash TEXT`);
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

  inboxSig(): string {
    const cands = this.candidates()
      .map((c) => `${c.id}:${c.verdict}:${c.refusal ? "r" : "p"}`)
      .join(",");
    return `${this.tracesCount()}|${this.liveCount()}|${this.receiptsCount()}|${this.lastHeartbeat()}|${cands}`;
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
    this.db.run(
      `INSERT OR REPLACE INTO tools (id, name, version, program, state, prev, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      [t.id, t.name, t.version, JSON.stringify(t.program), t.state, t.prev ? JSON.stringify(t.prev) : null, t.created_at, t.updated_at],
    );
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

  putReceipt(r: Omit<StoredReceipt, "id" | "created_at"> & { id?: string }): void {
    this.db.run(
      `INSERT INTO receipts (id, tool_id, version, ms, llm_calls, cents, ok, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [r.id ?? crypto.randomUUID(), r.tool_id, r.version, r.ms, r.llm_calls, r.cents, r.ok, Date.now()],
    );
    const n = (this.db.query(`SELECT COUNT(*) as n FROM receipts`).get() as { n: number }).n;
    if (n > 5000) {
      this.db.run(`DELETE FROM receipts WHERE id IN (SELECT id FROM receipts ORDER BY created_at ASC LIMIT ?)`, [n - 5000]);
    }
  }

  receipts(): StoredReceipt[] {
    return this.db.query(`SELECT * FROM receipts ORDER BY created_at DESC`).all() as StoredReceipt[];
  }

  receiptsFor(toolId: string): StoredReceipt[] {
    return this.db.query(`SELECT * FROM receipts WHERE tool_id = ? ORDER BY created_at DESC`).all(toolId) as StoredReceipt[];
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

  savings(): { runs: number; fail: number; llmReductionMean: number; live: number } {
    const live = this.tools().filter((t) => t.state === "live");
    let runs = 0;
    let fail = 0;
    let red = 0;
    let withM = 0;
    for (const t of live) {
      const stats = this.receiptStats(t.id);
      runs += stats.n;
      fail += stats.fail;
      const m = t.program.manifest?.llmReduction;
      if (m && Number.isFinite(m)) {
        red += m;
        withM++;
      }
    }
    return { runs, fail, llmReductionMean: withM ? red / withM : 0, live: live.length };
  }
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
  return {
    id: String(r.id),
    name: String(r.name),
    version: String(r.version),
    program,
    state: r.state as LiveTool["state"],
    prev: parsePrev(r.prev),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}
