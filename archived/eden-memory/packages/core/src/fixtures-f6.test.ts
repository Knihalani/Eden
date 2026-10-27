import { describe, expect, test } from "bun:test";
import { compileTraces } from "../../compile/src/index";
import { cutIslands, heuristicName } from "./islands";
import type { IslandStep, ToolEvent } from "./types";
import { runProgram, registryFrom } from "../../runtime/src/index";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/21
export type { IslandStep };

/** Minimal local mirror of @eden/ir's StretchTrace (core does not depend on ir). */
type FixtureTrace = {
  id: string;
  events: Array<{ name: string; args?: Record<string, unknown>; result?: unknown; ok?: boolean }>;
  input: Record<string, unknown>;
  output: unknown;
  llmCalls: number;
  duration_ms: number;
  cost_cents: number;
  complete: boolean;
};

/**
 * Fixture suite F6 (generalization plan §4) — claim C1's gate.
 *
 * Six unrelated domains; no vendor knowledge anywhere in the compiler. Each
 * fixture must mine a stretch, refuse its under-determined/mutating variants,
 * and replay deterministically where applicable. If F6 passes, "generalizable
 * by construction" has offline evidence; benchmark B1 (live agents) remains
 * the in-the-world gate.
 */

function bash(command: string, seq = 0): ToolEvent {
  return { event_id: `e${seq}-${command}`, seq, name: "Bash", args: { command }, command, ok: true };
}

function mcp(seq: number, name: string, args: Record<string, unknown>, result: unknown): ToolEvent {
  return { event_id: `e${seq}-${name}`, seq, name, args, ok: true };
}

function toTrace(
  id: string,
  events: Array<{ name: string; args?: Record<string, unknown>; result: unknown }>,
): FixtureTrace {
  return {
    id,
    events: events.map((e) => ({ name: e.name, args: e.args ?? {}, result: e.result, ok: true })),
    input: {},
    output: events.at(-1)?.result ?? null,
    llmCalls: events.length * 2,
    duration_ms: events.length * 500,
    cost_cents: events.length * 2,
    complete: true,
  };
}

describe("F6 fixture suite — six domains, zero vendor knowledge", () => {
  test("F1 kubernetes ops: get pods/svc/deployments per namespace compiles and replays", async () => {
    const mk = (ns: string, id: string): FixtureTrace => ({
      id,
      events: [
        { name: "Bash", args: { command: `kubectl get pods -n ${ns}` }, result: { pods: [ns] }, ok: true },
        { name: "Bash", args: { command: `kubectl get svc -n ${ns}` }, result: { svc: [] }, ok: true },
        { name: "Bash", args: { command: `kubectl get deployments -n ${ns}` }, result: { d: [] }, ok: true },
      ],
      input: { namespace: ns },
      output: { ns },
      llmCalls: 6,
      duration_ms: 6000,
      cost_cents: 6,
      complete: true,
    });
    const mined = compileTraces([mk("dev", "a"), mk("stage", "b"), mk("prod", "c")] as unknown as Parameters<
      typeof compileTraces
    >[0]);
    expect(mined.programs.length).toBe(1);
    const ran: string[] = [];
    await runProgram(
      mined.programs[0]!,
      { namespace: "prod" },
      {
        registry: registryFrom({
          Bash: async (args) => {
            ran.push(String(args.command));
            return {};
          },
        }),
        checkEnvelope: false,
      },
    );
    expect(ran).toEqual(["kubectl get pods -n prod", "kubectl get svc -n prod", "kubectl get deployments -n prod"]);
  });

  test("F2 cloud storage: s3 list variants slot into one skeleton; cp never reads", () => {
    const islands = cutIslands([bash("aws s3 ls s3://bucket-a"), bash("aws s3 ls s3://bucket-b")], {
      allowRunnerOnly: true,
    });
    // Two list calls differing only by bucket = one parameterized identity.
    // Runner-kind steps stay local-only (hosted playback refuses them
    // honestly), and cautious binaries never read-classify, so nothing here
    // can be reordered or deduped away.
    expect(islands.length).toBe(1);
    expect(islands[0]!.every((s) => s.name.startsWith("aws.s3.ls"))).toBe(true);
    expect(islands[0]!.every((s) => s.commute === false)).toBe(true);
    const cpIslands = cutIslands([bash("aws s3 cp s3://a/f.json ./f.json"), bash("echo done")], {
      allowRunnerOnly: true,
    });
    // A copy is work, not plumbing — but a single non-repeated command has no
    // repetition evidence, so no island forms.
    expect(cpIslands.length).toBe(0);
  });

  test("F3 payments API: invoice+lines bundle names itself from host+chain", () => {
    const islands = cutIslands([
      bash("curl -s https://api.stripe.com/v1/invoices/in_123"),
      bash("curl -s https://api.stripe.com/v1/invoices/in_123/lines"),
    ]);
    expect(islands.length).toBe(1);
    expect(heuristicName(islands[0]!)).toBe("stripe_invoices_lines");
    expect(islands[0]!.every((s) => s.kind === "cloud_http")).toBe(true);
  });

  test("F4 SQL analytics: psql variants cluster by skeleton, never as reads", () => {
    // Free-form SQL bodies vary per witness → one slot-ridden skeleton.
    // Compiling it is safe precisely because nothing is claimed about the
    // queries: steps are runner-kind, non-commuting (sequential), and
    // hosted playback refuses them. Local registries replay the recorded
    // commands verbatim through template bindings instead.
    const islands = cutIslands(
      [
        bash("psql -c \"SELECT count(*) FROM orders WHERE status='open'\""),
        bash("psql -c \"SELECT count(*) FROM users WHERE created_at > '2026-01-01'\""),
        bash('psql -c "SELECT sum(total) FROM invoices"'),
      ],
      { allowRunnerOnly: true },
    );
    expect(islands.length).toBe(1);
    expect(islands[0]!.every((s) => s.name.startsWith("psql."))).toBe(true);
    expect(islands[0]!.every((s) => s.commute === false)).toBe(true);
  });

  test("F5 notion/MCP product verbs: three-verb flow compiles through the standard pipeline", () => {
    const mk = (pageId: string, id: string): FixtureTrace => ({
      id,
      events: [
        mcp(0, "mcp__notion__query_database", { database_id: "db_1" }, { results: [{ id: pageId }] }),
        mcp(1, "mcp__notion__update_page", { page_id: pageId, properties: {} }, { id: pageId }),
        mcp(2, "mcp__notion__create_comment", { page_id: pageId, rich_text: "done" }, { id: `c-${pageId}` }),
      ],
      input: { pageId },
      output: { moved: [pageId] },
      llmCalls: 9,
      duration_ms: 9000,
      cost_cents: 9,
      complete: true,
    });
    const mined = compileTraces([mk("p-1", "n1"), mk("p-2", "n2"), mk("p-3", "n3")] as unknown as Parameters<
      typeof compileTraces
    >[0]);
    expect(mined.refusals.length).toBe(0);
    expect(mined.programs[0]!.sequence).toEqual([
      "mcp__notion__query_database",
      "mcp__notion__update_page",
      "mcp__notion__create_comment",
    ]);
  });

  test.failing("G5: structured-body binding — JSON POST bodies template from witnesses", async () => {
    const mk = (id: string, status: string): Record<string, unknown> => ({
      id,
      events: [
        { name: "get_issue", args: { issue_number: 12 }, result: { id: 12, state: status }, ok: true },
        {
          name: "post_comment",
          args: { issue_number: 12, body: JSON.stringify({ text: `Status: ${status}`, author: "bot" }) },
          result: { comment_id: 1 },
          ok: true,
        },
        { name: "verify_comment", args: { issue_number: 12 }, result: { verified: true }, ok: true },
      ],
      input: { issue_number: 12, status },
      output: { commented: true },
      llmCalls: 6,
      duration_ms: 6000,
      cost_cents: 6,
      complete: true,
    });
    const mined = compileTraces([mk("s1", "open"), mk("s2", "closed"), mk("s3", "blocked")] as unknown as Parameters<
      typeof compileTraces
    >[0]);
    expect(mined.refusals.length).toBe(0);
    expect(mined.programs.length).toBe(1);
    // The body arg should be a template binding with {status}.
    const postStep = mined.programs[0]!.steps.find((s) => s.kind === "tool" && s.tool === "post_comment") as any;
    expect(postStep).toBeTruthy();
    const bodyBinding = postStep.args.body;
    expect(bodyBinding.kind).toBe("transform");
    expect(bodyBinding.expr).toContain("{status}");
    // Replay against a registry that captures the actual rendered body.
    // get_issue compiles as an island (divergent results), so replay needs
    // an island caller that returns the right state from the input.
    const bodies: string[] = [];
    const islandCaller = async ({ input }: { input: unknown }) => {
      const inp = input as Record<string, unknown>;
      return { id: inp.issue_number ?? 12, state: "reopened" };
    };
    const reg = registryFrom({
      post_comment: async (args) => {
        bodies.push(String(args!.body ?? ""));
        return { comment_id: 1 };
      },
      verify_comment: async () => ({ verified: true }),
    });
    await runProgram(
      mined.programs[0]!,
      { issue_number: 12, status: "reopened" },
      {
        registry: reg,
        checkEnvelope: false,
        island: islandCaller,
      },
    );
    // The runtime's interpolateSlots resolved {status} while preserving the
    // surrounding JSON braces.
    const parsed = JSON.parse(bodies[0]!);
    expect(parsed.text).toBe("Status: reopened");
    expect(parsed.author).toBe("bot");
  });

  test("F6 web research: fetch+extract loop over search results compiles generically", () => {
    const islands = cutIslands([
      bash("for u in https://a.example/x https://b.example/y; do curl -sL $u; done"),
      bash("echo researching"),
    ]);
    // Two distinct fetch targets → two commuting GET steps on one island.
    expect(islands.length).toBe(1);
    expect(islands[0]!.every((s) => s.kind === "cloud_http")).toBe(true);
  });
});
