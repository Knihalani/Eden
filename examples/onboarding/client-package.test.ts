import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPartner, createHandler } from "@eden/server";
import { StaticSource } from "@eden/sources";

// Path (a) of the onboarding smoke tests (D365): an agent outside this monorepo installs the packed client, and both
// Node (plain ESM, no TypeScript loader) and tsc with Node16 resolution accept it. No network, no keys. The pack
// runs as its own process, as an adopter runs it: in-process, Bun.build and the TypeScript compiler shared a parallel
// test worker with other files, and one of them then saw a Buffer that was not Node's (review finding).

const node = Bun.which("node");
const tsc = resolve(import.meta.dir, "../../node_modules/.bin/tsc");
const pack = resolve(import.meta.dir, "../../packages/client/pack.ts");

const runIn = async (cwd: string, argv: string[]) => {
  const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

// tsc's launcher is a Node script, so without Node neither half can run: skipped visibly, not passed silently.
describe.skipIf(!node)("bun run pack:client", () => {
  test("a project outside the repo imports it from Node, gets a packet from a real server, and type-checks", async () => {
    const root = mkdtempSync(join(tmpdir(), "eden-pack-"));
    const partner = buildPartner({
      sources: async () => [
        new StaticSource("calendar", "The user's calendar", [
          { ref: "evt-priya", title: "Lunch with Priya Raman", text: "Thursday 12:30 at Dishoom, confirmed" },
        ]),
      ],
      model: null,
    });
    const server = Bun.serve({ port: 0, fetch: createHandler(partner, { keys: new Map(), dev: true }) });
    try {
      const pkg = join(root, "eden-client");
      const packed = await runIn(root, ["bun", pack, pkg]);
      expect(packed.err).toBe("");
      expect(packed.code).toBe(0);
      // What `npm install <dir>` does for a local folder: a link under node_modules.
      const app = join(root, "my-agent");
      mkdirSync(join(app, "node_modules/@eden"), { recursive: true });
      symlinkSync(pkg, join(app, "node_modules/@eden/client"), "dir");
      writeFileSync(join(app, "package.json"), JSON.stringify({ name: "my-agent", type: "module" }));
      const agent = `import { EdenClient, withContext } from "@eden/client";
const errors: string[] = [];
const eden = new EdenClient({ baseUrl: process.argv[2], userId: "u", sessionId: "s", onError: (e) => errors.push(String(e)) });
const text = "What time is lunch with Priya Raman?";
const { injection } = await eden.observe({ kind: "user_message", text });
const messages = withContext([{ role: "user", content: text }], await eden.collect(injection));
console.log(JSON.stringify({ messages, errors }));
`;
      writeFileSync(join(app, "agent.ts"), agent);
      // The same file as plain JS for Node (its one type annotation removed).
      writeFileSync(join(app, "agent.mjs"), agent.replace(": string[]", ""));

      const { out, err, code } = await runIn(app, [node!, "agent.mjs", server.url.href.replace(/\/$/, "")]);
      expect(err).toBe("");
      expect(code).toBe(0);
      const got = JSON.parse(out) as { messages: { role: string; content: string }[]; errors: string[] };
      expect(got.errors).toEqual([]);
      expect(got.messages.map((m) => m.role)).toEqual(["system", "user"]);
      expect(got.messages[0]!.content).toContain("Dishoom");
      // Under Node, fetch refuses a URL with credentials and quotes it in its message: the error must not carry them.
      const leak = await runIn(app, [node!, "agent.mjs", "http://me:secret@127.0.0.1:9/?token=hush"]);
      const failed = JSON.parse(leak.out) as { errors: string[] };
      expect(failed.errors.length).toBeGreaterThan(0);
      expect(failed.errors.join("\n")).not.toMatch(/secret|hush/);
      expect(failed.errors[0]).toContain("eden /v1/events: cannot reach http://127.0.0.1:9/");

      // `process` is the only Node global the agent uses; declared so the check needs no @types/node.
      writeFileSync(join(app, "globals.d.ts"), "declare const process: { argv: string[] };\n");
      writeFileSync(
        join(app, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            module: "node16",
            moduleResolution: "node16",
            target: "es2022",
            strict: true,
            noEmit: true,
            types: [],
            lib: ["es2022", "dom"],
          },
          files: ["agent.ts", "globals.d.ts"],
        }),
      );
      const t = Bun.spawn([tsc, "-p", "tsconfig.json"], { cwd: app, stdout: "pipe", stderr: "pipe" });
      const [tout, tcode] = await Promise.all([new Response(t.stdout).text(), t.exited]);
      expect(tout).toBe("");
      expect(tcode).toBe(0);
    } finally {
      server.stop(true);
      partner.stopSync();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
