import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// deploy/scripts/autoscale-plan.py (S1-P5) on --metrics-dir stand-ins: no node is reached; every case writes the
// nodes file and each node's <id>.metrics and runs the planner with a pinned --now and TZ=UTC.

const root = join(import.meta.dir, "..", "..");
const script = join(root, "deploy/scripts/autoscale-plan.py");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function metrics(users: number, rssMb: number, extra = "") {
  return (
    `eden_users_held ${users}\n` +
    `eden_process_resident_bytes ${Math.round(rssMb * 1_048_576)}\n` +
    `eden_processes_ready 16\n` +
    `eden_sync_users_waiting_first_page 0\n` +
    `eden_sync_kick_queue_users 0\n` +
    extra
  );
}

function run(nodes: [string, string | null][], args: string[]): { out: string; code: number; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "eden-autoscale-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "nodes.txt"),
    nodes.map(([id]) => `${id}=http://10.0.0.${id.slice(1)}:8790`).join("\n") + "\n",
  );
  const md = join(dir, "m");
  mkdirSync(md);
  for (const [id, body] of nodes) {
    if (body !== null) writeFileSync(join(md, `${id}.metrics`), body);
  }
  const p = Bun.spawnSync(
    [
      "python3",
      "-I",
      script,
      "--nodes-file",
      join(dir, "nodes.txt"),
      "--metrics-dir",
      md,
      "--state",
      join(dir, "s.json"),
      ...args,
    ],
    { env: { ...process.env, TZ: "UTC" } },
  );
  return { out: p.stdout.toString() + p.stderr.toString(), code: p.exitCode, dir };
}

const at = (h: number) => String(Math.floor(Date.UTC(2026, 10, 21, h) / 1000)); // 2026-11-21, UTC

test("a loaded fleet scales out, bounded to a tenth of its nodes a reading", () => {
  // 4 GB a box plans ~194 users (937 usable / 1.024 / 4.71); 2 x 1000 users projects 2440 → need 13+1.
  const { out, code } = run(
    [
      ["n1", metrics(1000, 1000)],
      ["n2", metrics(1000, 1000)],
    ],
    ["--ram-gb", "4", "--processes", "16", "--now", at(12)],
  );
  expect(code).toBe(0);
  expect(out).toContain("plan: add 1 node(s) → 3");
  expect(out).toContain("node_count = 3");
  expect(out).toContain("move bounded to 10% of the fleet");
});

test("a scale-in waits consecutive below-need readings, then releases", () => {
  // 128 GB a box plans ~19k users; 3 nodes x 50 needs 1+1 spare = 2 < 3.
  const nodes: [string, string][] = [
    ["n1", metrics(50, 300)],
    ["n2", metrics(50, 300)],
    ["n3", metrics(50, 300)],
  ];
  const base = ["--ram-gb", "128", "--processes", "16", "--now", at(22)]; // 22:00 UTC is off-peak
  const dir = mkdtempSync(join(tmpdir(), "eden-auto-"));
  dirs.push(dir);
  const go = () => {
    const r = run(nodes, base);
    // share the state file across the three readings
    const p = Bun.spawnSync(
      [
        "python3",
        "-I",
        script,
        "--nodes-file",
        join(r.dir, "nodes.txt"),
        "--metrics-dir",
        join(r.dir, "m"),
        "--state",
        join(dir, "s.json"),
        "--ram-gb",
        "128",
        "--processes",
        "16",
        "--now",
        at(22),
      ],
      { env: { ...process.env, TZ: "UTC" } },
    );
    return p.stdout.toString() + p.stderr.toString();
  };
  expect(go()).toContain("plan: keep 3 nodes");
  expect(go()).toContain("plan: keep 3 nodes");
  expect(go()).toContain("plan: remove 1 node(s) → 2");
});

test("a scale-in never runs inside peak hours", () => {
  const nodes: [string, string][] = [
    ["n1", metrics(50, 300)],
    ["n2", metrics(50, 300)],
    ["n3", metrics(50, 300)],
  ];
  const dir = mkdtempSync(join(tmpdir(), "eden-auto-"));
  dirs.push(dir);
  for (let i = 0; i < 4; i++) {
    const r = run(nodes, ["--ram-gb", "128", "--processes", "16", "--now", at(12), "--state", join(dir, "s.json")]);
    // state was written under r.dir's own --state; point at the shared one instead
    const md = join(r.dir, "m");
    const p = Bun.spawnSync(
      [
        "python3",
        "-I",
        script,
        "--nodes-file",
        join(r.dir, "nodes.txt"),
        "--metrics-dir",
        md,
        "--state",
        join(dir, "s.json"),
        "--ram-gb",
        "128",
        "--processes",
        "16",
        "--now",
        at(12),
      ],
      { env: { ...process.env, TZ: "UTC" } },
    );
    const out = p.stdout.toString() + p.stderr.toString();
    expect(out).toContain("inside peak hours 7-19: holding");
    expect(out).toContain("plan: keep 3 nodes");
  }
});

test("a node that does not answer counts as full: missing data never shrinks the fleet", () => {
  const { out } = run(
    [
      ["n1", metrics(50, 300)],
      ["n2", metrics(50, 300)],
      ["n3", null],
    ],
    ["--ram-gb", "128", "--processes", "16", "--now", at(22)],
  );
  expect(out).toContain("DOWN (counts as full)");
  expect(out).toContain("missing data never shrinks the fleet");
  expect(out).toContain("plan: keep 3 nodes");
});

test("a node over 85% RSS forces a scale-out whatever the user math says", () => {
  // n1 holds no users (so it feeds no per-user reading) yet sits over 85% RSS — e.g. memory outside
  // Eden's accounting. The user math alone would hold the fleet; the urgent clause adds a node.
  const { out } = run(
    [
      ["n1", metrics(0, 3600)], // 3600 MB > 85% of 4 GB
      ["n2", metrics(50, 300)],
    ],
    ["--ram-gb", "4", "--processes", "16", "--now", at(12)],
  );
  expect(out).toContain("URGENT: n1 over 85% RSS");
  expect(out).toContain("plan: add 1 node(s) → 3");
});

test("a silent node still carries demand: the live mean stands in, so load is never erased", () => {
  // n2 silent, n1 at 100 users: the silent node is estimated at the live mean (100), so 200 projected users
  // a ~194-a-box fleet needs 2 + 1 spare = 3 > 2. Without the stand-in the plan would wrongly keep 2.
  const { out } = run(
    [
      ["n1", metrics(100, 300)],
      ["n2", null],
    ],
    ["--ram-gb", "4", "--processes", "16", "--now", at(12)],
  );
  expect(out).toContain("plan: add 1 node(s) → 3");
});

test("a node with children missing from its own scrape reports partial data — never a scale-in basis", () => {
  const partial = metrics(50, 300).replace("eden_processes_ready 16", "eden_processes_ready 3");
  const { out } = run(
    [
      ["n1", metrics(50, 300)],
      ["n2", metrics(50, 300)],
      ["n3", partial],
    ],
    ["--ram-gb", "128", "--processes", "16", "--now", at(22)],
  );
  expect(out).toContain("missing data never shrinks the fleet");
  expect(out).toContain("plan: keep 3 nodes");
});

test("a peak range that wraps midnight still guards the night hours", () => {
  const nodes: [string, string][] = [
    ["n1", metrics(50, 300)],
    ["n2", metrics(50, 300)],
    ["n3", metrics(50, 300)],
  ];
  const dir = mkdtempSync(join(tmpdir(), "eden-auto-"));
  dirs.push(dir);
  for (let i = 0; i < 4; i++) {
    const r = run(nodes, ["--ram-gb", "128", "--processes", "16", "--now", at(22)]);
    const p = Bun.spawnSync(
      [
        "python3",
        "-I",
        script,
        "--nodes-file",
        join(r.dir, "nodes.txt"),
        "--metrics-dir",
        join(r.dir, "m"),
        "--state",
        join(dir, "s.json"),
        "--ram-gb",
        "128",
        "--processes",
        "16",
        "--now",
        at(22),
        "--peak-hours",
        "19-7",
      ],
      { env: { ...process.env, TZ: "UTC" } },
    );
    const out = p.stdout.toString() + p.stderr.toString();
    expect(out).toContain("inside peak hours 19-7: holding");
    expect(out).toContain("plan: keep 3 nodes");
  }
});

test("--cidr renders the nodes-file lines the new count implies (tofu cidrhost N+11)", () => {
  const { out } = run(
    [
      ["n1", metrics(1000, 1000)],
      ["n2", metrics(1000, 1000)],
    ],
    ["--ram-gb", "4", "--processes", "16", "--now", at(12), "--cidr", "10.1.0.0/16"],
  );
  expect(out).toContain("n3=http://10.1.0.13:8790");
});

test("a draining node's held users still count as demand", () => {
  // ready=0 on a drain: the node is leaving but its users are real — replacing them with users_per_box (~152
  // here) would lose demand. n1 drains with 400 held; with them counted the fleet needs 5, without them it
  // only holds (a scale-in is already blocked by the missing data).
  const draining = metrics(400, 300).replace("eden_processes_ready 16", "eden_processes_ready 0");
  const r = run(
    [
      ["n1", draining],
      ["n2", metrics(30, 300)],
      ["n3", metrics(30, 300)],
      ["n4", metrics(30, 300)],
    ],
    ["--ram-gb", "4", "--processes", "16", "--now", at(12)],
  );
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/add/i);
  expect(r.out).not.toMatch(/release/i);
});
