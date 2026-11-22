import { describe, expect, test } from "bun:test";
import { tmpDir } from "@eden/primitives";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reusableArms, type Task } from "./ab-common";
import { isRecap, recapOf, shiftClocks } from "./pi-day";
import { planUser, suiteTemplates, userWorldOf, withDayRecaps } from "./pi-user";
import { kindSlots, parseKinds, sameSelection, selectionKey, selectionLine, taskSelection } from "./task-kinds";

describe("task kinds", () => {
  test("canonical selection, all kinds, duplicates, empty and unknown arguments", () => {
    expect(parseKinds("control, hidden,control")).toEqual(["hidden", "control"]);
    expect(parseKinds("neutral")).toEqual(["neutral"]);
    expect(parseKinds("neutral,hidden,control")).toEqual(["hidden", "control", "neutral"]);
    for (const s of ["", "hidden,", "wrong", "--dry"]) expect(() => parseKinds(s)).toThrow("--kinds");
    expect([...kindSlots([], null)]).toEqual([]);
    expect(taskSelection(null, []).kinds).toEqual([]);
  });

  test("selection retains full slots, days, ids, task contents, clock times and recap world mutations", () => {
    const plan = planUser(41, suiteTemplates(41, ["heldout18"]), {
      days: 3,
      size: [4, 4],
      mix: { hidden: 1, control: 1, neutral: 2 },
    });
    const u = userWorldOf(41, plan);
    const before = JSON.stringify(u);
    const tasks = withDayRecaps(u.tasks, u.daySizes, (t, d) => recapOf(t, `day${d}:recap`));
    const trace = (kinds: Task["kind"][] | null) => {
      const world = structuredClone(u.world);
      let clock = world.now;
      let newDay = true;
      let day = -1;
      const planted = new Set<string>();
      const states: unknown[] = [];
      const ran: Task[] = [];
      for (const { task, run } of kindSlots(tasks, kinds)) {
        clock += newDay && day >= 0 ? 7_200_000 : 600_000;
        if (newDay) {
          day++;
          planted.clear();
        }
        newDay = isRecap(task);
        if (!isRecap(task) && task.planted) planted.add(task.planted);
        if (isRecap(task))
          for (const it of world.items)
            if (planted.has(it.id)) {
              it.text = shiftClocks(it.text).text;
              it.updatedAt = clock;
            }
        states.push([task.id, day, clock, JSON.stringify(world.items)]);
        if (run) ran.push(task);
      }
      return { states, ran };
    };
    const full = trace(null);
    for (const kinds of [["hidden", "control"], ["neutral"], ["hidden"], []] as Task["kind"][][]) {
      const filtered = trace(kinds);
      expect(filtered.states).toEqual(full.states);
      expect(filtered.ran.filter(isRecap)).toHaveLength(3);
      expect(filtered.ran.filter((t) => !isRecap(t))).toEqual(u.tasks.filter((t) => kinds.includes(t.kind)));
      for (const t of filtered.ran) expect(tasks.includes(t)).toBe(true);
    }
    expect(JSON.stringify(u)).toBe(before);
  });

  test("legacy/full runs pair, same filters pair, unlike traffic never pairs or reuses", () => {
    const full = taskSelection(null, [{ kind: "hidden" }, { kind: "neutral" }]);
    const filtered = taskSelection(parseKinds("hidden,control"), []);
    expect(() => sameSelection([undefined, full])).not.toThrow();
    expect(() => sameSelection([filtered, { ...filtered, kinds: ["control", "hidden"] }])).not.toThrow();
    expect(selectionKey(filtered)).toBe("reduced-traffic:hidden,control");
    expect(selectionLine(filtered)).toContain("connector RNG/quota");
    for (const other of [undefined, full, taskSelection(["neutral"], [])])
      expect(() => sameSelection([filtered, other])).toThrow("never pool, pair or reuse");
    expect(() =>
      reusableArms(
        { model: "fake", grader: "fake", seeds: [], suites: [], tasks: [], results: [] },
        { model: "fake", grader: "fake", seeds: [], suites: [], tasks: [], taskSelection: filtered },
        [],
      ),
    ).toThrow("task kinds/traffic differ");
  });

  test("Pi skips excluded calls and grades, keeps full plan/recaps; both paired reports reject mixing", async () => {
    const dir = tmpDir("task-kinds-");
    const run = async (name: string, extra: string[]) => {
      const out = join(dir, `${name}.json`);
      const log = join(dir, `${name}.log`);
      const p = Bun.spawn(
        [
          "bun",
          "--preload",
          join(import.meta.dir, "fake-openrouter.ts"),
          join(import.meta.dir, "pi-ab.ts"),
          "--suite",
          "heldout18",
          "--seeds",
          "41",
          "--days",
          "2",
          "--day-size",
          "4",
          "--mix",
          "1:1:2",
          "--conditions",
          "tools,none",
          "--time-scale",
          "0",
          "--out",
          out,
          ...extra,
        ],
        {
          env: { ...process.env, OPENROUTER_API_KEY: "fake", EDEN_ALLOW_OPENROUTER: "1", FAKE_LOG: log },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const stderr = await new Response(p.stderr).text();
      expect(await p.exited, stderr).toBe(0);
      const file = JSON.parse(readFileSync(out, "utf8"));
      const calls = readFileSync(log, "utf8").trim().split("\n");
      return { file, out, calls };
    };
    const [full, filtered, neutral] = await Promise.all([
      run("full", []),
      run("filtered", ["--kinds", "hidden,control"]),
      run("neutral", ["--kinds", "neutral"]),
    ]);
    for (const reduced of [filtered, neutral]) {
      expect(reduced.file.tasks).toEqual(full.file.tasks);
      expect(reduced.file.user).toEqual(full.file.user);
      expect(reduced.file.taskSelection.mode).toBe("reduced-traffic");
      expect(reduced.file.results).toHaveLength(8);
      expect(reduced.calls.filter((l: string) => l.startsWith("agent"))).toHaveLength(12);
      expect(reduced.calls.filter((l: string) => l === "grader")).toHaveLength(8);
      const changed = (f: typeof reduced.file) =>
        f.days.map((d: { day: string; condition: string; changed: number }) => [d.day, d.condition, d.changed]).sort();
      expect(changed(reduced.file)).toEqual(changed(full.file));
      const meta = new Map<string, Task>(reduced.file.tasks.map((t: Task) => [t.id, t]));
      expect(
        reduced.file.results.every((r: { task: string }) =>
          reduced.file.taskSelection.kinds.includes(meta.get(r.task)!.kind),
        ),
      ).toBe(true);
    }
    expect(full.calls.filter((l: string) => l.startsWith("agent"))).toHaveLength(20);
    expect(full.calls.filter((l: string) => l === "grader")).toHaveLength(16);
    for (const script of ["agent-ab-report.ts", "pi-ab-report.ts", "pi-cost-report.ts", "act-report.ts"]) {
      const mixed = Bun.spawnSync(["bun", join(import.meta.dir, script), full.out, filtered.out]);
      expect(mixed.exitCode).not.toBe(0);
      expect(mixed.stderr.toString()).toContain("task kinds/traffic differ");
      const paired = Bun.spawnSync(["bun", join(import.meta.dir, script), filtered.out]);
      expect(paired.exitCode, paired.stderr.toString()).toBe(0);
      expect(paired.stdout.toString()).toContain("TASK KINDS: hidden,control; reduced-traffic");
    }
    const equivalent = join(dir, "equivalent.json");
    writeFileSync(
      equivalent,
      JSON.stringify({
        ...filtered.file,
        taskSelection: { ...filtered.file.taskSelection, kinds: ["control", "hidden"] },
      }),
    );
    const combined = Bun.spawnSync(["bun", join(import.meta.dir, "pi-ab-report.ts"), filtered.out, equivalent]);
    expect(combined.exitCode, combined.stderr.toString()).toBe(0);
    const capture = join(dir, "capture-ledger.ts");
    writeFileSync(
      capture,
      `import { mock } from "bun:test";
      const record = (entry, rows) => { console.log("LEDGER_CAPTURE " + JSON.stringify({ entry, rows })); return {id: "test"}; };
      mock.module(${JSON.stringify(join(import.meta.dir, "ledger.ts"))}, () => ({record, tidy: x => x}));
      if ((await import(${JSON.stringify(join(import.meta.dir, "ledger.ts"))})).record !== record) throw new Error("ledger not mocked");`,
    );
    const ledger = Bun.spawnSync([
      "bun",
      "--preload",
      capture,
      join(import.meta.dir, "agent-ab-report.ts"),
      filtered.out,
      "--record",
      "filter-test",
    ]);
    expect(ledger.exitCode, ledger.stderr.toString()).toBe(0);
    const captured = JSON.parse(
      ledger.stdout
        .toString()
        .split("\n")
        .find((l) => l.startsWith("LEDGER_CAPTURE "))!
        .slice(15),
    );
    expect(captured.entry.config.taskSelection).toEqual(filtered.file.taskSelection);
    expect(captured.rows).toHaveLength(8);
    expect(
      captured.rows.every(
        (r: { taskSelection: unknown }) =>
          JSON.stringify(r.taskSelection) === JSON.stringify(filtered.file.taskSelection),
      ),
    ).toBe(true);
    const dry = Bun.spawnSync([
      "bun",
      join(import.meta.dir, "pi-ab.ts"),
      "--suite",
      "heldout18",
      "--seeds",
      "41",
      "--days",
      "2",
      "--day-size",
      "4",
      "--mix",
      "1:1:2",
      "--conditions",
      "tools,none",
      "--time-scale",
      "0",
      "--kinds",
      "hidden,control",
      "--project-from",
      full.out,
      "--dry",
    ]);
    expect(dry.exitCode, dry.stderr.toString()).toBe(0);
    expect(dry.stderr.toString()).toContain("4 selected of 8 planned tasks × 2 conditions");
    expect(dry.stderr.toString()).toContain("8 graded tasks");
  }, 60_000);
});
