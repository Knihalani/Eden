/**
 * The place and scope arms (A5 §4; D3–D5, A4 §2): facts stay in the folder they are true in, cascade from the
 * root unless a folder overrides them, are visible everywhere in a single-package repo, and a turn that spans two
 * folders gets one bullet that labels each folder's value.
 *
 * Place comes from what the turn touches: each cue follows a turn that names and reads a file of its folder.
 */
import { readFileSync } from "node:fs";
import type { SimWorld } from "../harness/session";
import type { WorldSpec } from "../harness/world";
import { AUTH, DB, id, monorepo, NODE, set, singlePackage, TEST } from "./fixtures/world";
import {
  bulletsAt,
  bulletsIn,
  check,
  DAY_MS,
  Driver,
  edenFiles,
  judged,
  needCheck,
  noStale,
  quote,
  read,
  type Arm,
  type Check,
  type Turn,
} from "./kit";
import { r5UnitRows } from "./scope-rows";

/** A turn that opens a file of `scope`'s folder, so the next cue's place is that folder. */
async function openFile(session: Driver, path: string): Promise<void> {
  await session.turn(`open ${path}`, { tools: [[read(path, `// ${path}\nexport {};\n`)]] });
}

/**
 * A5 `scoped`'s leak: from the first cue on, no stale bullet, and no cue packet carrying the other folder's values,
 * labelled or not (A4 §2: never siblings, outside a two-scope read set).
 */
function noLeak(world: SimWorld, spec: WorldSpec, from: number, cues: { web: Turn[]; cli: Turn[] }): Check {
  const stale = bulletsIn(judged(world, spec), from).filter((bullet) => bullet.stale);
  const carrying = (turns: Turn[], scope: string) =>
    turns
      .flatMap((turn) => bulletsAt(world, spec, turn.seq))
      .filter((bullet) => bullet.stated.some((stated) => stated.item.endsWith(`@${scope}`)));
  const leaked = [...carrying(cues.web, "packages/cli"), ...carrying(cues.cli, "apps/web")];
  const detail = `stale: ${quote(stale)}; the other folder's values in a cue's packet: ${quote(leaked)}`;
  return check("no-leak", stale.length === 0 && leaked.length === 0, detail);
}

/** Junk turns per session, as R6's longer sessions run. */
const JUNK_PER_SESSION = 8;
const JUNK_FOLDERS = ["apps/web/app", "packages/cli/src", "scripts"];
const JUNK_TASKS = [
  "refactor the retry loop in {path}",
  "add input validation to {path}",
  "write a test for the empty-input case in {path}",
  "explain what {path} does",
];

/** Junk turns of A5 `scoped`, each with a marker that must stay on disk (01-SHIP §"junk episodes still on disk"). */
async function junk(world: SimWorld, spec: WorldSpec, from: number, to: number): Promise<string[]> {
  const markers: string[] = [];
  for (let n = from; n < to; n += JUNK_PER_SESSION) {
    world.advance(DAY_MS / 4);
    const session = await Driver.start(world, spec);
    for (let k = n; k < Math.min(to, n + JUNK_PER_SESSION); k++) {
      const path = `${JUNK_FOLDERS[k % JUNK_FOLDERS.length]}/junk${k}.ts`;
      const marker = `junkmark${k}`;
      markers.push(marker);
      const task = JUNK_TASKS[k % JUNK_TASKS.length]!.replace("{path}", path);
      await session.turn(`${task} (ticket ${marker})`, { cue: { scope: path.split("/").slice(0, 2).join("/") } });
    }
    await session.end();
  }
  return markers;
}

/** The scale points of A5 `scoped`: junk turns before each round of cues. */
function scopedPoints(scale: "ci" | "full"): number[] {
  return scale === "full" ? [4752, 15840] : [48];
}

const scoped: Arm = {
  id: "scoped",
  flagged: true,
  async run(run) {
    const spec = monorepo();
    const world = run.world(spec);
    const facts = await Driver.start(world, spec);
    await facts.say(
      "In apps/web the auth provider is Clerk, and the database is postgres.",
      [set(AUTH, "apps/web", "Clerk"), set(DB, "apps/web", "postgres")],
      "apps/web",
    );
    await facts.say(
      "packages/cli has no auth, and its database is sqlite.",
      [set(AUTH, "packages/cli", "none"), set(DB, "packages/cli", "sqlite")],
      "packages/cli",
    );
    await facts.end();
    const web: Turn[] = [];
    const cli: Turn[] = [];
    const markers: string[] = [];
    let done = 0;
    let firstCue = Infinity;
    for (const point of scopedPoints(run.options.scale)) {
      markers.push(...(await junk(world, spec, done, point)));
      done = point;
      world.advance(DAY_MS);
      firstCue = Math.min(firstCue, world.log.length);
      const session = await Driver.start(world, spec);
      await openFile(session, "apps/web/app/login.ts");
      web.push(
        await session.ask("how does this app authenticate, and which database does it use?", {
          scope: "apps/web",
          needs: [id(AUTH, "apps/web"), id(DB, "apps/web")],
        }),
      );
      await openFile(session, "packages/cli/src/index.ts");
      cli.push(
        await session.ask("how does the cli authenticate, and which database does it use?", {
          scope: "packages/cli",
          needs: [id(AUTH, "packages/cli"), id(DB, "packages/cli")],
        }),
      );
      await session.end();
    }
    const stored = edenFiles(world)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const gone = markers.filter((marker) => !stored.includes(marker));
    return [
      needCheck("web-facts", world, spec, web),
      needCheck("cli-facts", world, spec, cli),
      noLeak(world, spec, firstCue, { web, cli }),
      check(
        "junk-on-disk",
        gone.length === 0,
        `${markers.length - gone.length} of ${markers.length} junk turns on disk; lost: ${gone.join(", ") || "none"}`,
      ),
    ];
  },
};

const cascade: Arm = {
  id: "cascade",
  flagged: true,
  async run(run) {
    const spec = monorepo();
    const world = run.world(spec);
    const facts = await Driver.start(world, spec);
    await facts.say("We use node 20 across the repo.", [set(NODE, "", "20")]);
    await facts.say("apps/web runs node 22.", [set(NODE, "apps/web", "22")], "apps/web");
    await facts.end();
    world.advance(DAY_MS);
    const from = world.log.length;
    const session = await Driver.start(world, spec);
    await openFile(session, "apps/web/app/login.ts");
    const web = await session.ask("which node version should apps/web use?", {
      scope: "apps/web",
      needs: [id(NODE, "apps/web")],
    });
    await openFile(session, "packages/cli/src/index.ts");
    const cli = await session.ask("which node version should packages/cli use?", {
      scope: "packages/cli",
      needs: [id(NODE, "packages/cli")],
    });
    const root = await session.ask("which node version does the repo use by default?", { needs: [id(NODE, "")] });
    await session.end();
    return [
      needCheck("web-22", world, spec, [web]),
      needCheck("cli-20", world, spec, [cli]),
      needCheck("root-20", world, spec, [root]),
      noStale(world, spec, from),
    ];
  },
};

const singlePackageArm: Arm = {
  id: "single-package",
  flagged: true,
  async run(run) {
    const spec = singlePackage();
    const world = run.world(spec);
    const facts = await Driver.start(world, spec);
    await facts.say("The test runner is vitest.", [set(TEST, "", "vitest")]);
    await facts.say("The database is sqlite.", [set(DB, "", "sqlite")]);
    await facts.end();
    world.advance(DAY_MS);
    const session = await Driver.start(world, spec);
    await openFile(session, "src/db.ts");
    const db = await session.ask("which database does src/db.ts talk to?", { needs: [id(DB, "")] });
    await openFile(session, "test/db.test.ts");
    const tests = await session.ask("which test runner do the tests in test/ use?", { needs: [id(TEST, "")] });
    await session.end();
    return [needCheck("visible-everywhere", world, spec, [db, tests])];
  },
};

const fanOut: Arm = {
  id: "fan-out",
  flagged: true,
  async run(run) {
    const spec = monorepo({ projectFiles: { "packages/cli/src/login.ts": "export function login() {}\n" } });
    const world = run.world(spec);
    const facts = await Driver.start(world, spec);
    await facts.say("In apps/web the auth provider is Clerk.", [set(AUTH, "apps/web", "Clerk")], "apps/web");
    await facts.say("packages/cli has no auth.", [set(AUTH, "packages/cli", "none")], "packages/cli");
    await facts.end();
    world.advance(DAY_MS);
    const session = await Driver.start(world, spec);
    const files = ["apps/web/app/login.ts", "packages/cli/src/login.ts"];
    const from = world.log.length;
    await session.turn("look at both login flows", { tools: [files.map((path) => read(path, `// ${path}\n`))] });
    const cue = await session.ask(`make login in ${files[0]} and ${files[1]} behave the same`, {
      needs: [id(AUTH, "apps/web"), id(AUTH, "packages/cli")],
    });
    await session.end();
    // The turn's packets: its batch's first touch of both folders (A4 §5.5, since P3.5), then the cue's.
    const bullets = bulletsIn(judged(world, spec), from, cue.seq + 1);
    const twoScope = bullets.filter(
      (bullet) =>
        bullet.stated.some((s) => s.item === id(AUTH, "apps/web") && s.value === "Clerk") &&
        bullet.stated.some((s) => s.item === id(AUTH, "packages/cli") && s.value === "none"),
    );
    return [
      check("two-scope-bullet", twoScope.length > 0, `the turn's packets: ${quote(bullets)}`),
      needCheck("needs-met", world, spec, [cue]),
    ];
  },
};

export const PLACE_ARMS: Arm[] = [scoped, cascade, singlePackageArm, fanOut, r5UnitRows];
