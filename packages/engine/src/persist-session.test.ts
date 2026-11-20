/**
 * A frozen user keeps its sessions' delivery knowledge (ledger snapshot and delivered list, written in the blob's
 * `extra.sessions`): a daemon respawned between turns, or a user handed between machines, serves fresh sessions
 * seeded with it, so nothing the agent already holds is handed out again.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Scope } from "@eden/protocol";
import { StaticSource, type Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { EncryptedFrozenDisk } from "./persist";
import type { UsageRecord } from "./trace";

const HOUR = 3_600_000;
const KEY = new Uint8Array(32).map((_, i) => i + 3);
const user: Scope = { tenantId: "t", userId: "u1" };
let clock = 1_700_000_000_000;
const ev = (e: Record<string, unknown>) => ({ ...user, sessionId: "a", at: clock++, ...e }) as AgentEvent;

const crm: Source = new StaticSource("crm", "Deals and accounts", [
  {
    ref: "deal-9",
    title: "Globex renewal",
    text: "Globex renewal due 2026-11-30, Dana Lee is the champion, wants 12% off",
  },
]);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function partner(
  dir: string,
  onUsage?: (record: UsageRecord) => void,
  idleMs?: number,
  cfg?: Partial<typeof CORE_CONFIG>,
): ContextPartner {
  const cache = new ItemCache();
  cache.persist(new EncryptedFrozenDisk({ dir, key: KEY, maxBytes: 64 << 20, maxAgeMs: 7 * 24 * HOUR }));
  return new ContextPartner({
    sources: async () => [crm],
    sourceMap: new SourceMap(),
    cache,
    budget: new Budget(),
    model: null,
    config: { ...CORE_CONFIG, ...(idleMs === undefined ? {} : { sessionIdleMs: idleMs }), ...cfg },
    onUsage,
  });
}

describe("session knowledge carried with a frozen user", () => {
  test("a restored user's new session is not handed what the released one delivered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-sess-"));
    dirs.push(dir);
    const a = partner(dir);
    const got = await a.observe(ev({ kind: "user_message", text: "What about the Globex renewal?" }), {
      waitMs: 2_000,
    });
    expect(got.injection?.citations.map((c) => c.itemId)).toContain("crm:deal-9");
    expect(a.release(user)).toBe(true);

    const b = partner(dir);
    // The same session continuing after the respawn: what it already handed stays handed.
    const again = await b.observe(
      ev({ kind: "user_message", sessionId: "a", text: "What about the Globex renewal?" }),
      { waitMs: 2_000 },
    );
    expect(again.injection).toBeNull();
    // A new conversation of the same user is not seeded (BUG_0001): its agent never held the item.
    const fresh = await b.observe(
      ev({ kind: "user_message", sessionId: "c", text: "What about the Globex renewal?" }),
      { waitMs: 2_000 },
    );
    expect(fresh.injection?.citations.map((c) => c.itemId)).toContain("crm:deal-9");
  });

  test("an injection still awaiting a use verdict survives the respawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-sess-"));
    dirs.push(dir);
    const a = partner(dir);
    const got = await a.observe(ev({ kind: "user_message", text: "What about the Globex renewal?" }), {
      waitMs: 2_000,
    });
    const injectionId = got.injection?.id;
    expect(injectionId).toBeTruthy();
    expect(a.release(user)).toBe(true);

    const b = partner(dir);
    await b.observe(ev({ kind: "user_message", sessionId: "a", text: "anything to get the session live" }), {
      waitMs: 2_000,
    });
    // Outstanding rode the blob: explicit feedback still reaches the use verdict for `crm`.
    expect(
      b.feedback({
        tenantId: "t",
        userId: "u1",
        sessionId: "a",
        injectionId: injectionId!,
        used: true,
        how: "explicit",
      }),
    ).toBe(true);
  });

  test("a judged injection is not re-seeded when the session is evicted and reopened", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-sess-"));
    dirs.push(dir);
    const a = partner(dir);
    const got = await a.observe(ev({ kind: "user_message", text: "What about the Globex renewal?" }), {
      waitMs: 2_000,
    });
    const injectionId = got.injection?.id;
    expect(injectionId).toBeTruthy();
    expect(a.release(user)).toBe(true);

    const records: UsageRecord[] = [];
    const b = partner(
      dir,
      (r) => {
        if (r.injectionId === injectionId) records.push(r);
      },
      0,
    );
    await b.observe(ev({ kind: "user_message", sessionId: "a", text: "back again" }), { waitMs: 2_000 });
    expect(
      b.feedback({
        tenantId: "t",
        userId: "u1",
        sessionId: "a",
        injectionId: injectionId!,
        used: true,
        how: "explicit",
      }),
    ).toBe(true);
    expect(records).toHaveLength(1);

    // `sessionIdleMs: 0`: creating session "x" evicts "a" without learning; the user then returns to it before
    // any re-freeze, so `restoredSessions` still holds the blob it was thawed from.
    await b.observe(ev({ kind: "user_message", sessionId: "x", text: "unrelated" }), { waitMs: 0 });
    await b.observe(ev({ kind: "user_message", sessionId: "a", text: "and again" }), { waitMs: 0 });
    // The judged injection must not come back as outstanding: a second verdict would count it twice.
    b.feedback({ tenantId: "t", userId: "u1", sessionId: "a", injectionId: injectionId!, used: true, how: "explicit" });
    expect(records).toHaveLength(1);
  });

  test("a restored user keeps the probe economy it learned (D2001)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-sess-"));
    dirs.push(dir);
    const a = partner(dir);
    await a.observe(ev({ kind: "user_message", text: "What about the Globex renewal?" }), { waitMs: 2_000 });
    const econ = (p: ContextPartner) => (p as unknown as { economy: import("./economy").ProbeEconomy }).economy;
    const items = [{ id: "deal-9", sourceId: "crm", ref: "deal-9", title: "Globex renewal", text: "the renewal" }];
    // Six re-asks past FRESH_WARMUP: the answer's change chance is a learned number under the never-asked 1.
    for (let i = 0; i < 7; i++) {
      econ(a).answered(user, "crm", "globex renewal", items, clock + i * 60_000);
    }
    const askedAt = econ(a).askedAt(user, "crm", "globex renewal");
    const learned = econ(a).changeChance(user, "crm", "globex renewal", clock + 8 * 60_000);
    expect(learned).toBeLessThan(1);
    expect(econ(a).userCount).toBe(1);
    expect(a.release(user)).toBe(true);
    expect(econ(a).userCount).toBe(0);

    const b = partner(dir);
    await b.observe(ev({ kind: "user_message", sessionId: "n1", text: "hi" }), { waitMs: 0 });
    // The learned rates rode the blob: askedAt comes back exactly, and the same query is a known
    // number under 1 — not the never-asked 1 a fresh economy returns.
    expect(econ(b).askedAt(user, "crm", "globex renewal")).toBe(askedAt);
    expect(econ(b).changeChance(user, "crm", "globex renewal", clock + 8 * 60_000)).toBeLessThan(1);
  });

  test("a restored user keeps what each source earned it (D2002)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-sess-"));
    dirs.push(dir);
    const a = partner(dir, undefined, undefined, { sourceYield: true });
    await a.observe(ev({ kind: "user_message", text: "What about the Globex renewal?" }), { waitMs: 2_000 });
    const yields = (p: ContextPartner) =>
      (p as unknown as { yields: import("./source-yield").SourceYield | null }).yields!;
    // crm has been read twice with nothing used, and a second source earned its reads already.
    yields(a).read(user, ["crm", "files"], clock);
    yields(a).read(user, ["crm"], clock + 1_000);
    yields(a).used(user, ["files"], clock + 2_000);
    expect(yields(a).run(user, "crm", clock + 2_000)).toBeGreaterThan(1);
    expect(yields(a).hasYielded(user, "files")).toBe(true);
    expect(a.release(user)).toBe(true);

    const b = partner(dir, undefined, undefined, { sourceYield: true });
    await b.observe(ev({ kind: "user_message", sessionId: "n1", text: "hi" }), { waitMs: 0 });
    // Runs and yields rode the blob: crm's run is not restarted at 0, and files still counts as earned.
    expect(yields(b).run(user, "crm", clock + 2_000)).toBeGreaterThan(1);
    expect(yields(b).hasYielded(user, "files")).toBe(true);
  });

  test("a restored user still corrects an ended session's verdict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-sess-"));
    dirs.push(dir);
    const a = partner(dir);
    const got = await a.observe(ev({ kind: "user_message", text: "What about the Globex renewal?" }), {
      waitMs: 2_000,
    });
    const injectionId = got.injection!.id;
    // session_end learns the outstanding injection "ended" (unused) into `recorded`.
    await a.observe(ev({ kind: "session_end" }));
    expect(a.release(user)).toBe(true);

    const b = partner(dir);
    // Any event on the scope thaws the user; the injection's session is gone — only `recorded` can answer.
    await b.observe(ev({ kind: "user_message", sessionId: "n1", text: "hi" }), { waitMs: 0 });
    expect(b.feedback({ ...user, sessionId: "a", injectionId, used: true, how: "explicit" })).toBe(true);
  });

  test("a restored user keeps its held unverifiable re-reads (D2003)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-sess-"));
    dirs.push(dir);
    // An MCP-like source whose null fetch proves nothing (`fetchReportsGone` false): the re-read's
    // "unverifiable" stands until the next signal.
    const docs = [{ ref: "m1", title: "Quarterly plan", text: "quarterly plan draft for review" }];
    const mail = new (class extends StaticSource {
      override readonly fetchReportsGone = false;
      readonly notifies = true;
      fetches = 0;
      override async fetch(): Promise<null> {
        this.fetches++;
        return null;
      }
      gone = false; // Upstream delete: the poll's page no longer lists m1, so its held copy stays in doubt.
      async list(): Promise<{ items: ContextItem[]; next: null }> {
        const items = this.gone ? [] : docs.map((d) => ({ ...d, id: itemId("mail", d.ref), sourceId: "mail" }));
        return { items, next: null };
      }
    })("mail", "Mail", docs);
    const make = () => {
      const cache = new ItemCache();
      cache.persist(new EncryptedFrozenDisk({ dir, key: KEY, maxBytes: 64 << 20, maxAgeMs: 7 * 24 * HOUR }));
      return new ContextPartner({
        sources: async () => [mail],
        sourceMap: new SourceMap(),
        cache,
        budget: new Budget(),
        model: null,
        config: {
          ...CORE_CONFIG,
          verifyDelivery: true,
          sync: true,
          syncPush: true,
          syncOnDemand: true,
          syncPageSize: 5,
          syncPollPageSize: 5,
          syncCallsPerMin: 600,
        },
      });
    };
    const held = (p: ContextPartner) =>
      (p as unknown as { unverifiable: Map<string, Map<string, { mark: number }>> }).unverifiable;
    const a = make();
    // Warm the user's sync state so `sourceChanged` doubts the held copy (an unsynced source ignores it).
    a.sync!.track(user);
    for (let i = 0; i < 20 && !a.sync!.warm(user); i++) await a.sync!.tick();
    // First ask syncs m1 into the user's cache; the signal doubts that copy, so the next delivery
    // re-reads it — a null that proves nothing, held "unverifiable" (D211).
    mail.gone = true;
    expect(a.sourceChanged(user, "mail")).toBe(true);
    await a.ask({ ...user, sessionId: "s1", question: "quarterly plan draft" });
    expect(mail.fetches).toBe(1);
    const m1 = itemId("mail", "m1");
    expect(held(a).get("t/u1")?.has(m1)).toBe(true);
    expect(a.release(user)).toBe(true);

    const b = make();
    await b.observe(ev({ kind: "user_message", sessionId: "n1", text: "hi" }), { waitMs: 0 });
    // The held re-read rode the blob, and its mark was re-read as the copy's mark in this process —
    // the saved counter compares against nothing here (the dead process's mark space).
    const row = held(b).get("t/u1")?.get(m1);
    expect(row).toBeDefined();
    const copyMark = (
      b as unknown as { deps: { cache: { readMark(s: Scope, id: string): number | undefined } } }
    ).deps.cache.readMark(user, m1);
    expect(row!.mark).toBe(copyMark);
  });
});
