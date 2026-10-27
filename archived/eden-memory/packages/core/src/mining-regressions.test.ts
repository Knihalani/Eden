import { describe, expect, test } from "bun:test";
import { cleanEvents, cutIslands } from "./islands";
import { commandMatchesToolUrls, parameterizeUrl } from "./urls";
import type { ToolEvent } from "./types";

function bash(cmd: string, seq: number): ToolEvent {
  return { event_id: `e${seq}`, seq, name: "Bash", args: {}, command: cmd, ok: true };
}

describe("write steps survive mining", () => {
  test("two identical POSTs to the same endpoint are not compiled down to one", () => {
    // parameterizeUrl collapses /issues/5 and /issues/7 onto one shape; the
    // dedupe used to key on that shape alone and silently dropped the second
    // write — an agent using the compiled tool would have posted one comment.
    const events = [
      bash("curl -X POST https://api.acme.com/v1/issues/5/comments -d 'hi'", 0),
      bash("curl -X POST https://api.acme.com/v1/issues/7/comments -d 'again'", 1),
    ];
    const islands = cutIslands(events);
    const all = islands.flat();
    expect(all.length).toBe(2);
  });

  test("two different curls with empty args are not merged", () => {
    // cleanEvents compared name+args only. Hook recordings that carry the
    // command at the top level leave args as {}, so two *different* calls
    // collapsed into one and the second never reached mining.
    const events = [
      { event_id: "a", seq: 0, name: "Bash", args: {}, command: "curl -s https://api.acme.com/v1/issues/12", ok: true },
      { event_id: "b", seq: 1, name: "Bash", args: {}, command: "curl -s https://api.acme.com/v1/pulls/12", ok: true },
    ];
    expect(cleanEvents(events).length).toBe(2);
  });

  test("consecutive identical reads still collapse", () => {
    // Double-recording by hook + proxy is real and harmless for reads.
    const events = [bash("curl https://api.acme.com/v1/orders/1", 0), bash("curl https://api.acme.com/v1/orders/1", 1)];
    expect(cleanEvents(events).length).toBe(1);
  });

  test("consecutive identical writes do not collapse", () => {
    const post = "curl -X POST https://api.acme.com/v1/labels -d 'bug'";
    const events = [bash(post, 0), bash(post, 1)];
    expect(cleanEvents(events).length).toBe(2);
  });

  test("byte-identical mutating MCP events survive as two", () => {
    // The mutation guard used to be shell-only: isMutatingCurl/isMutatingGh
    // have nothing to say about an MCP event, so two byte-identical
    // mcp__linear__create_issue calls collapsed into one — silent
    // under-execution. A name that is not positively a read never collapses.
    const mk = (seq: number): ToolEvent => ({
      event_id: `e${seq}`,
      seq,
      name: "mcp__linear__create_issue",
      args: { title: "hi", team: "eng" },
      ok: true,
    });
    expect(cleanEvents([mk(0), mk(1)])).toHaveLength(2);
  });

  test("byte-identical product-verb writes survive as two", () => {
    const mk = (seq: number): ToolEvent => ({
      event_id: `e${seq}`,
      seq,
      name: "create_record",
      args: { table: "orders", data: "x" },
      ok: true,
    });
    expect(cleanEvents([mk(0), mk(1)])).toHaveLength(2);
  });

  test("identical non-shell reads still collapse", () => {
    // Double-recording by hook + proxy stays harmless for provably-read names.
    const read = (name: string, seq: number): ToolEvent => ({
      event_id: `e${seq}`,
      seq,
      name,
      args: { issue: "12" },
      ok: true,
    });
    expect(cleanEvents([read("get_issue", 0), read("get_issue", 1)])).toHaveLength(1);
    expect(cleanEvents([read("list_comments", 0), read("list_comments", 1)])).toHaveLength(1);
    expect(cleanEvents([read("mcp__linear__get_issue", 0), read("mcp__linear__get_issue", 1)])).toHaveLength(1);
    expect(cleanEvents([read("fetchUserDetails", 0), read("fetchUserDetails", 1)])).toHaveLength(1);
  });

  test("an interleaved read repeat does not collapse (W1)", () => {
    // get_issue, list_comments, get_issue: only *adjacent* identical reads
    // are double-recording. The last get_issue may legitimately see a
    // different world than the first — collapsing it would compile a tool
    // that under-reports.
    const read = (name: string, seq: number): ToolEvent => ({
      event_id: `e${seq}`,
      seq,
      name,
      args: { issue: "12" },
      ok: true,
    });
    expect(cleanEvents([read("get_issue", 0), read("list_comments", 1), read("get_issue", 2)])).toHaveLength(3);
  });

  test("byte-identical mutating generic-shell repeats do not collapse (probe HIGH-1)", () => {
    // Non-curl/gh binaries used to fail OPEN (treated as reads), so identical
    // repeats of destructive commands collapsed into one — the exact
    // double-recording under-execution the mutation rule exists to prevent.
    const mk = (command: string, seq: number): ToolEvent => ({
      event_id: `e${seq}`,
      seq,
      name: "Bash",
      args: { command },
      command,
      ok: true,
    });
    expect(
      cleanEvents([mk("terraform destroy -auto-approve", 0), mk("terraform destroy -auto-approve", 1)]),
    ).toHaveLength(2);
    expect(
      cleanEvents([
        mk('psql -c "INSERT INTO ledger(amount) VALUES (100)"', 0),
        mk('psql -c "INSERT INTO ledger(amount) VALUES (100)"', 1),
      ]),
    ).toHaveLength(2);
    expect(cleanEvents([mk("docker stop web", 0), mk("docker stop web", 1)])).toHaveLength(2);
    // Reads still collapse.
    expect(cleanEvents([mk("kubectl get pods -n prod", 0), mk("kubectl get pods -n prod", 1)])).toHaveLength(1);
  });

  test("same args in a different key order do not collapse (W1)", () => {
    // Comparison is structural-adjacent via JSON text; differing key order
    // stays two events. Conservative on purpose: collapsing a call whose
    // arguments merely serialized differently risks under-execution, while
    // keeping it costs one extra mining candidate.
    const mk = (seq: number, flip: boolean): ToolEvent => ({
      event_id: `e${seq}`,
      seq,
      name: "get_issue",
      args: flip ? { issue: "12", team: "eng" } : { team: "eng", issue: "12" },
      ok: true,
    });
    expect(cleanEvents([mk(0, false), mk(1, true)])).toHaveLength(2);
  });

  test("byte-identical mutating-compound names survive as two", () => {
    // nameIsRead used to test READ_VERB anywhere in the name after camelCase
    // word-breaking, so a mutating compound whose head or object contained a
    // read word ("get", "read", "list", "status") classified as a read and its
    // byte-identical repeats collapsed into one — silent under-execution.
    // getOrCreateRecord, readThenWrite, listAndCharge, update_status (matches
    // "status"!) and trigger_fetch all carry a mutating word; none may collapse.
    const mk = (name: string, seq: number): ToolEvent => ({
      event_id: `e${seq}`,
      seq,
      name,
      args: { id: "7" },
      ok: true,
    });
    for (const name of ["getOrCreateRecord", "readThenWrite", "listAndCharge", "update_status", "trigger_fetch"]) {
      expect(cleanEvents([mk(name, 0), mk(name, 1)])).toHaveLength(2);
    }
  });
});

describe("steering url matching", () => {
  test("${sha} in a re-run command matches a tool compiled from a recorded ${sha}", () => {
    const recorded = "gh api repos/o/r/commits/${sha}/status";
    // The mine side substituted abcde12345 (10 hex) when recording; the
    // steering side used to substitute "12", which failed the 5-hex rule and
    // never matched the compiled tool's /commits/{sha} shape.
    expect(commandMatchesToolUrls(recorded, ["https://api.github.com/repos/o/r/commits/{sha}/status"])).toBe(true);
  });

  test("a numeric segment before a fragment parameterizes like a bare one", () => {
    expect(parameterizeUrl("https://shop.example.com/orders/5#top")).toBe("https://shop.example.com/orders/{id}#top");
  });

  test("unrelated commands still do not match", () => {
    expect(
      commandMatchesToolUrls("gh api repos/o/r/issues/3", ["https://api.github.com/repos/o/r/pulls/{issue}"]),
    ).toBe(false);
  });
});
