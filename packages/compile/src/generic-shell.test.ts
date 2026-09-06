import { describe, expect, test } from "bun:test";
import type { StretchTrace } from "@eden/ir";
import { compileTraces } from "./index";
import { runProgram, registryFrom } from "../../runtime/src/index";

/**
 * Domain-general compilation: shell stretches. No vendor knowledge anywhere
 * in this file — the commands are an arbitrary CLI, and the compiler must
 * qualify them by repetition, abstract the varying tokens into parameters
 * (including positional ones like the pod name in `kubectl logs <app>`),
 * and emit a program that replays against a plain registry that only knows
 * how to run "Bash".
 */
describe("generic shell compilation", () => {
  function trace(ns: string, app: string, id: string): StretchTrace {
    return {
      id,
      events: [
        {
          name: "Bash",
          args: { command: `kubectl get pods -n ${ns}` },
          result: { pods: [`api-${ns}`, `web-${ns}`] },
          ok: true,
        },
        {
          name: "Bash",
          args: { command: `kubectl get svc -n ${ns}` },
          result: { svc: [`api-svc-${ns}`] },
          ok: true,
        },
        {
          name: "Bash",
          args: { command: `kubectl get deployments -n ${ns}` },
          result: { deployments: [`api-dep-${ns}`] },
          ok: true,
        },
        {
          // The G13 case: a positional argument varying across witnesses.
          // Without variation-driven slot abstraction each of these read as
          // its own subcommand shape and the stretch never clustered.
          name: "Bash",
          args: { command: `kubectl logs ${app} -n ${ns}` },
          result: { lines: 12 },
          ok: true,
        },
      ],
      input: { namespace: ns, app },
      output: { ns },
      llmCalls: 8,
      duration_ms: 8000,
      cost_cents: 8,
      complete: true,
    };
  }

  test("a kubectl stretch with positional-arg slots compiles to template steps", () => {
    const mined = compileTraces([trace("dev", "api", "k1"), trace("stage", "web", "k2"), trace("prod", "jobs", "k3")]);
    expect(mined.refusals.length).toBe(0);
    expect(mined.programs.length).toBe(1);
    const p = mined.programs[0]!;
    expect(p.sequence).toEqual([
      "Bash:kubectl.get.pods.n.{v0}",
      "Bash:kubectl.get.svc.n.{v0}",
      "Bash:kubectl.get.deployments.n.{v0}",
      "Bash:kubectl.logs.{v0}.n.{v1}",
    ]);
    for (const s of p.steps) {
      if (s.kind !== "tool") continue;
      expect(s.tool).toBe("Bash");
      const cmd = s.args.command as { kind: string; expr?: string };
      expect(cmd.kind).toBe("transform");
    }
    // The logs step carries BOTH slots — positional app and flag namespace.
    const logs = p.steps.find((s) => s.id.includes("logs")) as unknown as {
      args: { command: { expr?: string } };
    };
    expect(logs.args.command.expr).toContain("{app}");
    expect(logs.args.command.expr).toContain("{namespace}");
  });

  test("the compiled program replays against a plain Bash registry", async () => {
    const mined = compileTraces([trace("dev", "api", "k1"), trace("stage", "web", "k2"), trace("prod", "jobs", "k3")]);
    const p = mined.programs[0]!;
    const ran: string[] = [];
    const registry = registryFrom({
      Bash: async (args: Record<string, unknown>) => {
        ran.push(String(args.command));
        return {};
      },
    });
    const out = await runProgram(p, { namespace: "prod", app: "web" }, { registry, checkEnvelope: false });
    expect(ran).toEqual([
      "kubectl get pods -n prod",
      "kubectl get svc -n prod",
      "kubectl get deployments -n prod",
      "kubectl logs web -n prod",
    ]);
    expect(out.stats.llmCalls).toBe(0);
  });

  test("an unseen namespace is outside the witness envelope", async () => {
    const mined = compileTraces([trace("dev", "api", "k1"), trace("stage", "web", "k2"), trace("prod", "jobs", "k3")]);
    const p = mined.programs[0]!;
    const calls: string[] = [];
    const registry = registryFrom({
      Bash: async (args: Record<string, unknown>) => {
        calls.push(String(args.command));
        return {};
      },
    });
    await expect(
      runProgram(p, { namespace: "chaos", app: "web" }, { registry, checkEnvelope: true }),
    ).rejects.toMatchObject({ deopt: true });
    expect(calls).toEqual([]);
  });
});
