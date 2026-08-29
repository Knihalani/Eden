import type { StretchProgram } from "@eden/ir";
import { describe, expect, test } from "bun:test";
import { createState } from "./wrap-tools";
import { handleChatCompletions } from "./proxy";
import { injectTools } from "./steer";
import {
  messageText,
  rankPrograms,
  selectForRequest,
  selectSurfacePrograms,
  dispatchPrograms,
  surfaceMode,
  createJitGuard,
  noteJitUsed,
  JIT_UNUSED_DEMOTE,
} from "./intent";

/**
 * Dispatch surface policy (docs/dispatch.md). The catalog lives in the
 * runtime; these tests pin how much of it a request may see, and what counts
 * as evidence to surface exactly one tool.
 */

function prog(opts: {
  name: string;
  seq?: string[];
  url?: string;
  cmd?: string;
}): StretchProgram {
  const first = opts.seq?.[0] ?? opts.name;
  const args: Record<string, unknown> = {};
  if (opts.url) args.u = { kind: "literal", value: opts.url };
  if (opts.cmd) args.command = { kind: "transform", fn: "template", expr: opts.cmd };
  return {
    id: `p_${opts.name}`,
    version: "v1",
    name: opts.name,
    description: "",
    inputSchema: { type: "object", properties: {} },
    steps: [{ id: "s0", kind: "tool", tool: first, args }] as never,
    returns: { kind: "input", path: "" },
    contract: { envelope: { inputs: {} } } as never,
    manifest: {} as never,
    sequence: opts.seq ?? [first],
  };
}

const GH = prog({
  name: "github_pr_bundle",
  seq: ["Bash", "web_fetch", "Bash"],
  url: "https://api.github.com/repos/acme/app/pulls/12",
});
const KUBECTL = prog({ name: "kubectl_get_pods", seq: ["Bash"], cmd: "kubectl get pods -n {namespace}" });
// No literals, no envelope witnesses: this program has no structural shape,
// so only token overlap could ever match it — and overlap alone is not proof.
const TICKET = prog({ name: "fetchTicketBundle", seq: ["fetchTicket", "checkStock"] });

const GH_MESSAGE = [
  { role: "user", content: "Look at https://api.github.com/repos/acme/app/pulls/12 and summarize the reviews" },
];
const KUBECTL_MESSAGE = [{ role: "user", content: "kubectl get pods -n prod and tell me what's crashing" }];
const VAGUE_MESSAGE = [{ role: "user", content: "please handle ticket 123" }];
const UNRELATED_MESSAGE = [{ role: "user", content: "write a sonnet about the sea" }];

function withEnv(v: string | undefined, fn: () => void): void {
  const old = process.env.EDEN_SURFACE;
  if (v === undefined) delete process.env.EDEN_SURFACE;
  else process.env.EDEN_SURFACE = v;
  try {
    fn();
  } finally {
    if (old === undefined) delete process.env.EDEN_SURFACE;
    else process.env.EDEN_SURFACE = old;
  }
}

describe("surface policy", () => {
  test("default mode is all — an upgrade changes nothing", () => {
    withEnv(undefined, () => expect(surfaceMode()).toBe("all"));
    withEnv("", () => expect(surfaceMode()).toBe("all"));
    withEnv("bogus", () => expect(surfaceMode()).toBe("all"));
  });

  test("modes parse", () => {
    withEnv("none", () => expect(surfaceMode()).toBe("none"));
    withEnv("jit", () => expect(surfaceMode()).toBe("jit"));
    withEnv("JIT-SHADOW", () => expect(surfaceMode()).toBe("jit-shadow"));
    withEnv("shadow", () => expect(surfaceMode()).toBe("jit-shadow"));
  });
});

describe("intent ranking", () => {
  test("a URL in the conversation surfaces the program that serves its shape", () => {
    const ranked = rankPrograms(GH_MESSAGE, [GH, KUBECTL, TICKET]);
    expect(ranked.length).toBeGreaterThanOrEqual(1);
    expect(ranked[0]!.program.name).toBe("github_pr_bundle");
    expect(ranked[0]!.via).toBe("shape");
  });

  test("a shell command surfaces the template program", () => {
    const ranked = rankPrograms(KUBECTL_MESSAGE, [GH, KUBECTL, TICKET]);
    expect(ranked.length).toBeGreaterThanOrEqual(1);
    expect(ranked[0]!.program.name).toBe("kubectl_get_pods");
  });

  test("word overlap alone never surfaces anything", () => {
    // "ticket" appears, but there is no URL or command structure anywhere.
    const ranked = rankPrograms(VAGUE_MESSAGE, [TICKET, GH]);
    expect(ranked.find((m) => m.program.name === "fetchTicketBundle")).toBeUndefined();
  });

  test("an unrelated conversation ranks nothing", () => {
    expect(rankPrograms(UNRELATED_MESSAGE, [GH, KUBECTL, TICKET])).toEqual([]);
  });

  test("a corrupt program is skipped, not fatal", () => {
    const broken = { ...prog({ name: "broken", url: "https://x.test/a/{id}" }), steps: null } as unknown as StretchProgram;
    expect(() => rankPrograms(GH_MESSAGE, [broken, GH])).not.toThrow();
    const ranked = rankPrograms(GH_MESSAGE, [broken, GH]);
    expect(ranked.find((m) => m.program.name === "broken")).toBeUndefined();
  });

  test("messageText reads both dialects' content blocks but ignores roles and ids", () => {
    const anthropicStyle = [
      { role: "user", content: [{ type: "text", text: "check https://api.github.com/repos/acme/app/pulls/9" }] },
    ];
    expect(messageText(anthropicStyle)).toContain("api.github.com");
    expect(messageText([{ role: "assistant", content: "irrelevant" }, ...GH_MESSAGE])).toContain("summarize");
  });
});

describe("selectSurfacePrograms", () => {
  test("all returns every live program", () => {
    const sel = selectSurfacePrograms({ mode: "all", live: [GH, KUBECTL], messages: UNRELATED_MESSAGE });
    expect(sel.surface).toEqual([GH, KUBECTL]);
  });

  test("jit without messages degrades to silence, not the full catalog", () => {
    const sel = selectSurfacePrograms({ mode: "jit", live: [GH, KUBECTL] });
    expect(sel.surface).toEqual([]);
  });

  test("jit surfaces at most one, and only on structural evidence", () => {
    const hit = selectSurfacePrograms({ mode: "jit", live: [TICKET, GH, KUBECTL], messages: GH_MESSAGE });
    expect(hit.surface.map((p) => p.name)).toEqual(["github_pr_bundle"]);
    const miss = selectSurfacePrograms({ mode: "jit", live: [TICKET, GH], messages: VAGUE_MESSAGE });
    expect(miss.surface).toEqual([]);
  });

  test("jit-shadow surfaces nothing but names what would have been surfaced", () => {
    const seen: string[][] = [];
    const sel = selectSurfacePrograms({
      mode: "jit-shadow",
      live: [TICKET, GH],
      messages: GH_MESSAGE,
      onShadow: (names) => seen.push(names),
    });
    expect(sel.surface).toEqual([]);
    expect(seen).toEqual([["github_pr_bundle"]]);
    // No evidence → no shadow noise either.
    selectSurfacePrograms({
      mode: "jit-shadow",
      live: [TICKET],
      messages: UNRELATED_MESSAGE,
      onShadow: (names) => seen.push(names),
    });
    expect(seen.length).toBe(1);
  });
});

describe("dispatchPrograms", () => {
  test("same messages → same single name as local JIT", () => {
    const live = [TICKET, GH, KUBECTL];
    const viaDispatch = dispatchPrograms(GH_MESSAGE, live).map((p) => p.name);
    const viaJit = selectSurfacePrograms({ mode: "jit", live, messages: GH_MESSAGE }).surface.map((p) => p.name);
    expect(viaDispatch).toEqual(viaJit);
    expect(viaDispatch).toEqual(["github_pr_bundle"]);
    expect(dispatchPrograms(VAGUE_MESSAGE, live)).toEqual([]);
    expect(dispatchPrograms(UNRELATED_MESSAGE, live)).toEqual([]);
    expect(dispatchPrograms(undefined, live)).toEqual([]);
    expect(dispatchPrograms([], live)).toEqual([]);
  });

  test("length is 0 or 1 even when several programs clear the bar", () => {
    const twin = prog({
      name: "github_pr_files",
      seq: ["web_fetch"],
      url: "https://api.github.com/repos/acme/app/pulls/12",
    });
    expect(dispatchPrograms(GH_MESSAGE, [GH, twin]).length).toBeLessThanOrEqual(1);
  });
});

describe("injectTools under the surface policy", () => {
  const clientTool = { type: "function", function: { name: "lookupTicket", parameters: {} } };

  test("default (env unset): historic behavior — every live program appended", () => {
    withEnv(undefined, () => {
      const out = injectTools([clientTool], [GH, KUBECTL]) as Array<{ function?: { name?: string } }>;
      expect(out.length).toBe(3);
      expect(out[0]!.function!.name).toBe("github_pr_bundle");
    });
  });

  test("none: client tools pass through untouched — steering still routes reactively", () => {
    withEnv("none", () => {
      const out = injectTools([clientTool], selectForRequest([GH], GH_MESSAGE)) as unknown[];
      expect(out.length).toBe(1);
      expect(out[0]).toBe(clientTool);
    });
  });

  test("jit: exactly one Eden schema, ahead of the client's own", () => {
    withEnv("jit", () => {
      const out = injectTools(
        [clientTool],
        selectForRequest([TICKET, GH], GH_MESSAGE),
      ) as Array<{ function?: { name?: string } }>;
      expect(out.length).toBe(2);
      expect(out[0]!.function!.name).toBe("github_pr_bundle");
      expect(out[1]).toBe(clientTool);
    });
  });

  test("jit with no evidence: nothing injected even though programs are live", () => {
    withEnv("jit", () => {
      const out = injectTools(
        [clientTool],
        selectForRequest([GH], VAGUE_MESSAGE),
      ) as unknown[];
      expect(out.length).toBe(1);
      expect(out[0]).toBe(clientTool);
    });
  });

  test("a non-array tools field still gets nothing back in any mode", () => {
    withEnv("all", () => {
      expect(injectTools(undefined, [GH])).toBeUndefined();
    });
    withEnv("jit", () => {
      expect(injectTools(undefined, selectForRequest([GH], GH_MESSAGE))).toBeUndefined();
    });
  });
});

describe("proxy wiring (handleChatCompletions)", () => {
  // The policy can be perfect and still useless if the handler never passes
  // messages through. These drive real requests through the proxy with a
  // capturing fake upstream and assert what the model would actually see.
  const UPSTREAM_OK = {
    id: "x",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  };

  async function proxied(envValue: string | undefined) {
    const clientTool = { type: "function", function: { name: "lookupTicket", parameters: {} } };
    let captured: { tools?: Array<{ function?: { name?: string } }> } = {};
    const old = process.env.EDEN_SURFACE;
    if (envValue === undefined) delete process.env.EDEN_SURFACE;
    else process.env.EDEN_SURFACE = envValue;
    try {
      const state = createState({
        programs: [GH],
        fetch: (async (_url: unknown, init?: { body?: string }) => {
          captured = JSON.parse(init!.body!);
          return new Response(JSON.stringify(UPSTREAM_OK));
        }) as unknown as typeof fetch,
      });
      const res = await handleChatCompletions(
        new Request("http://local/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model: "m", messages: GH_MESSAGE, tools: [clientTool] }),
        }),
        { state, getPrograms: () => [GH] },
      );
      await res.text();
    } finally {
      if (old === undefined) delete process.env.EDEN_SURFACE;
      else process.env.EDEN_SURFACE = old;
    }
    return captured.tools ?? [];
  }

  test("default surface: the upstream sees every live program's schema", async () => {
    const tools = await proxied(undefined);
    expect(tools.map((t) => t.function?.name)).toContain("github_pr_bundle");
    expect(tools.map((t) => t.function?.name)).toContain("lookupTicket");
  });

  test("jit surface: the upstream sees exactly one Eden schema, chosen from the conversation", async () => {
    const tools = await proxied("jit");
    const eden = tools.filter((t) => t.function?.name === "github_pr_bundle");
    expect(eden.length).toBe(1);
    expect(tools.some((t) => t.function?.name === "lookupTicket")).toBe(true);
  });

  test("none surface: the upstream sees only the client's own tools", async () => {
    const tools = await proxied("none");
    expect(tools.length).toBe(1);
    expect(tools[0]!.function!.name).toBe("lookupTicket");
  });
});

describe("JIT injection-rate guards", () => {
  test("default surface mode stays all — jit caps do not fire", () => {
    withEnv(undefined, () => {
      const jit = createJitGuard();
      for (let i = 0; i < 8; i++) {
        expect(selectForRequest([GH], GH_MESSAGE, jit).map((p) => p.name)).toEqual(["github_pr_bundle"]);
      }
      expect(jit.injections).toBe(0);
      expect(jit.demoted).toBe(false);
    });
  });

  test("jit caps injections per episode at jitMax (default 4)", () => {
    withEnv("jit", () => {
      const jit = createJitGuard();
      for (let i = 0; i < 4; i++) {
        expect(selectForRequest([GH], GH_MESSAGE, jit).map((p) => p.name)).toEqual(["github_pr_bundle"]);
        noteJitUsed(jit, ["github_pr_bundle"]);
      }
      expect(jit.injections).toBe(4);
      expect(selectForRequest([GH], GH_MESSAGE, jit)).toEqual([]);
      expect(selectForRequest([GH], GH_MESSAGE, jit)).toEqual([]);
    });
  });

  test("three consecutive unused injections demote the episode to S0", () => {
    withEnv("jit", () => {
      const jit = createJitGuard();
      expect(JIT_UNUSED_DEMOTE).toBe(3);
      expect(selectForRequest([GH], GH_MESSAGE, jit).map((p) => p.name)).toEqual(["github_pr_bundle"]);
      expect(selectForRequest([GH], GH_MESSAGE, jit).map((p) => p.name)).toEqual(["github_pr_bundle"]);
      expect(selectForRequest([GH], GH_MESSAGE, jit).map((p) => p.name)).toEqual(["github_pr_bundle"]);
      expect(selectForRequest([GH], GH_MESSAGE, jit)).toEqual([]);
      expect(jit.demoted).toBe(true);
      expect(selectForRequest([GH], GH_MESSAGE, jit)).toEqual([]);
    });
  });

  test("a used injection resets the unused streak", () => {
    withEnv("jit", () => {
      const jit = createJitGuard();
      expect(selectForRequest([GH], GH_MESSAGE, jit).map((p) => p.name)).toEqual(["github_pr_bundle"]);
      expect(selectForRequest([GH], GH_MESSAGE, jit).map((p) => p.name)).toEqual(["github_pr_bundle"]);
      noteJitUsed(jit, ["github_pr_bundle"]);
      expect(selectForRequest([GH], GH_MESSAGE, jit).map((p) => p.name)).toEqual(["github_pr_bundle"]);
      expect(selectForRequest([GH], GH_MESSAGE, jit).map((p) => p.name)).toEqual(["github_pr_bundle"]);
      expect(jit.demoted).toBe(false);
    });
  });

  test("a tool call in the next conversation counts as used", () => {
    withEnv("jit", () => {
      const jit = createJitGuard();
      expect(selectForRequest([GH], GH_MESSAGE, jit).map((p) => p.name)).toEqual(["github_pr_bundle"]);
      const follow = [
        ...GH_MESSAGE,
        { role: "assistant", tool_calls: [{ type: "function", function: { name: "github_pr_bundle", arguments: "{}" } }] },
      ];
      expect(selectForRequest([GH], follow, jit).map((p) => p.name)).toEqual(["github_pr_bundle"]);
      expect(jit.unusedStreak).toBe(0);
      expect(jit.demoted).toBe(false);
    });
  });
});
