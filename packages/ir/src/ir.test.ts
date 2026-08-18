import { describe, expect, test } from "bun:test";
import { canonicalize, cloneJson, containsRedaction, containsSecret, eq, flatten, getPath, hashProgram, hashTrace, inDistribution, interpolate, isSecretKey, isWeakValue, minLlmReductionOf, redact, redactString, validateProgram, withVersion } from "../src/index";
import type { StretchProgram } from "../src/index";

const mini = (): StretchProgram =>
  withVersion({
    id: "t",
    name: "t",
    description: "t",
    inputSchema: { type: "object" },
    steps: [{ id: "a", kind: "tool", tool: "x", args: { id: { kind: "input", path: "id" } } }],
    returns: { kind: "from", step: "a", path: "" },
    contract: { witnesses: 3, minLlmReduction: 5, allowExact: false },
    manifest: null,
  });

describe("ir", () => {
  test("rejects unknown step kind", () => {
    const p = mini();
    // "wasm" is intentionally not a real step kind — this is the input validateProgram must reject.
    (p as { steps: object[] }).steps = [{ id: "a", kind: "wasm", tool: "x", args: {} }];
    const issues = validateProgram(p);
    expect(issues.some((i) => i.message.includes("unknown step kind"))).toBe(true);
  });

  test("rejects unknown from.step", () => {
    const p = mini();
    (p.steps[0] as { args: Record<string, unknown> }).args.id = { kind: "from", step: "missing", path: "" };
    const issues = validateProgram(p);
    expect(issues.some((i) => i.message.includes("unknown step missing"))).toBe(true);
  });

  test("rejects unknown binding kind", () => {
    const p = mini();
    (p.steps[0] as { args: Record<string, unknown> }).args.id = { kind: "cegis", value: 1 };
    const issues = validateProgram(p);
    expect(issues.some((i) => i.message.includes("unknown binding kind"))).toBe(true);
  });

  test("hash is stable under key reorder", () => {
    const a = hashProgram(mini());
    const b = hashProgram(JSON.parse(canonicalize(mini())) as StretchProgram);
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  test("minLlmReduction defaults to 2×", () => {
    expect(minLlmReductionOf(undefined)).toBe(2);
    expect(minLlmReductionOf(NaN)).toBe(2);
    expect(minLlmReductionOf(0)).toBe(2);
    expect(minLlmReductionOf(2)).toBe(2);
    expect(minLlmReductionOf(5)).toBe(5);
  });

  test("hashTrace is content-addressed and ignores trace id", () => {
    const events = [{ name: "lookup", args: { id: "T-100" }, result: { ok: true }, ok: true }];
    const a = hashTrace({ events, input: { id: "T-100" } });
    const b = hashTrace({ events: [...events], input: { id: "T-100" } });
    const c = hashTrace({ events, input: { id: "T-101" } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64);
    const wired = hashTrace(JSON.parse(JSON.stringify({ events, input: { id: "T-100", skip: undefined } })));
    expect(hashTrace({ events, input: { id: "T-100", skip: undefined } })).toBe(wired);
  });

  test("getPath and eq", () => {
    expect(getPath({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(getPath({ a: { b: 1 } }, "$.a.b")).toBe(1);
    expect(eq({ a: 1 }, { a: 1 })).toBe(true);
    expect(eq({ a: 1 }, { a: 2 })).toBe(false);
  });

  test("cloneJson deep-copies objects", () => {
    const src = { a: { b: 1 } };
    const copy = cloneJson(src);
    expect(copy).toEqual(src);
    expect(copy).not.toBe(src);
    copy.a.b = 2;
    expect(src.a.b).toBe(1);
  });

  test("interpolate fills {path} from an object", () => {
    expect(interpolate("hi {id}", { id: "T-100" })).toBe("hi T-100");
    expect(interpolate("hi ${id}", { id: "T-100" })).toBe("hi T-100");
  });

  test("weak values", () => {
    expect(isWeakValue(true)).toBe(true);
    expect(isWeakValue("T-100")).toBe(false);
    expect(isWeakValue(0)).toBe(true);
  });

  test("redacts bearer, api_key, password", () => {
    const red = redact({
      authorization: "Bearer abc.def",
      api_key: "sk-secret",
      password: "hunter2",
      "x-api-key": "hdr-secret",
      jwt: "eyJhbGciOi",
      cookie: "sid=abc",
      "set-cookie": "sid=abc",
      "x-auth-token": "hdr",
      note: "Bearer tok_live_123 and api_key=xyz password=nope stay gone",
      ok: "hello",
    }) as Record<string, unknown>;
    expect(red.authorization).toBe("[REDACTED]");
    expect(red.api_key).toBe("[REDACTED]");
    expect(red.password).toBe("[REDACTED]");
    expect(red["x-api-key"]).toBe("[REDACTED]");
    expect(red.jwt).toBe("[REDACTED]");
    expect(red.cookie).toBe("[REDACTED]");
    expect(red["set-cookie"]).toBe("[REDACTED]");
    expect(red["x-auth-token"]).toBe("[REDACTED]");
    expect(red.ok).toBe("hello");
    expect(String(red.note)).not.toContain("tok_live");
    expect(String(red.note)).not.toContain("xyz");
    expect(String(red.note)).not.toContain("nope");
    expect(JSON.stringify(red)).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
    expect(JSON.stringify(red).toLowerCase()).not.toContain("hunter2");
    expect(JSON.stringify(red).toLowerCase()).not.toContain("sk-secret");
  });

  test("no envelope is out of distribution unless allowExact", () => {
    const p = mini();
    expect(inDistribution(p, { id: "T-100" })).toBe(false);
    const exact = { ...mini(), contract: { ...mini().contract, allowExact: true } };
    expect(inDistribution(exact, { id: "T-100" })).toBe(true);
  });

  test("eq requires matching keys and rejects non-plain objects", () => {
    expect(eq({ a: undefined }, { b: undefined })).toBe(false);
    expect(eq(new Date(1), new Date(2))).toBe(false);
    expect(eq({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  test("canonicalize distinguishes NaN from null and undefined", () => {
    expect(canonicalize(NaN)).toBe("NaN");
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(undefined)).toBe("undefined");
  });

  test("redact handles cycles, secretKey, and github tokens", () => {
    const cyclic: Record<string, unknown> = { secretKey: "abc" };
    cyclic.self = cyclic;
    const red = redact(cyclic) as Record<string, unknown>;
    expect(red.secretKey).toBe("[REDACTED]");
    // A back-edge is a cycle, not a credential: they get distinct sentinels so
    // that containsRedaction() cannot mistake a self-referential payload for a
    // secret and refuse an otherwise bindable slot.
    expect(red.self).toBe("[CYCLE]");
    expect(redactString("token ghp_abcdefghijklmnopqrstuvwxyz123456")).toContain("[REDACTED]");
  });

  test("redact is case-insensitive about credential spellings", () => {
    // The fast-path gate was case-sensitive where the replacer was not, so it
    // rejected the string before the replacer saw it. Uppercase is the normal
    // spelling for all three — they come from env dumps and config echoes —
    // and emitTrace() posted them to the collector verbatim.
    expect(redactString("Authorization: BEARER abc123def456")).toBe("Authorization: [REDACTED]");
    // The key names itself; only its value is a secret. Keeping the key makes
    // a redacted trace still readable, and costs nothing — "API_KEY" is not
    // the credential.
    expect(redactString("API_KEY=sk_live_9f8e7d6c5b4a3210")).toBe("API_KEY=[REDACTED]");
    expect(redactString("PASSWORD=hunter2")).toBe("PASSWORD=[REDACTED]");
    expect(redactString("SK-abcdefghijkl")).toBe("[REDACTED]");
    // Still exact about non-credentials.
    expect(redactString("the password policy is documented")).toBe("the password policy is documented");
  });

  test("value matching knows every family key matching knows", () => {
    // These were the two halves of the redactor and they disagreed: twenty
    // credential families were recognised as *keys* and eight as *values*. So
    // redact({secret: x}) redacted and redactString("SECRET=x") did not, and
    // the leak was not only in trace text — containsRedaction is the gate that
    // stops the compiler binding a credential in as a literal, and it can only
    // see what was rewritten to the sentinel.
    for (const s of [
      "SECRET=hunter2",
      "PASSWD=hunter2",
      "TOKEN=abc123def456",
      "ACCESS_TOKEN=abc123def456",
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "credentials: hunter2",
      "user_password: hunter2",
      "githubToken: abc123def456",
      "x_api_key: abc123def456",
    ]) {
      expect(redactString(s)).toContain("[REDACTED]");
      expect(redactString(s)).not.toContain("hunter2");
      expect(containsSecret(s)).toBe(true);
    }
    // Secret by their own syntax, with no key beside them.
    for (const s of [
      "sk_live_9f8e7d6c5b4a3210",
      "rk_live_9f8e7d6c5b4a3210",
      "AKIAIOSFODNN7EXAMPLE",
      "-----BEGIN RSA PRIVATE KEY-----",
    ]) {
      expect(redactString(s)).toContain("[REDACTED]");
      expect(containsSecret(s)).toBe(true);
    }
  });

  test("compound key names are credentials, ordinary words that contain them are not", () => {
    for (const k of ["user_password", "auth_token", "authToken", "github_token", "apiSecret", "x_api_key", "passwords"]) {
      expect(isSecretKey(k)).toBe(true);
    }
    // Suffix matching, not substring: a redactor that eats "author" and
    // "tokenizer" gets switched off by whoever has to read the traces.
    for (const k of ["author", "tokenizer", "session_count", "password_policy", "description"]) {
      expect(isSecretKey(k)).toBe(false);
    }
  });

  test("Bearer only matches at a word boundary", () => {
    expect(redactString("forbearer of tidings")).toBe("forbearer of tidings");
    expect(redactString("unBearer able thing")).toBe("unBearer able thing");
  });

  test("redact never throws, whatever the tool handed back", () => {
    // emitTrace() runs inside the success path of every wrapped call, so a
    // throw in here does not just lose a trace: it is caught by the caller's
    // error branch, recorded as a second bogus ok:false event for the same
    // call, and rethrown — the agent is told a tool that worked did not, and
    // the real result is discarded. Redaction failing must never fail the
    // tool call.
    const throwingGetter = {
      ok: true,
      get lazy(): never {
        throw new Error("getter blew up");
      },
    };
    expect(() => redact(throwingGetter)).not.toThrow();
    expect((redact(throwingGetter) as Record<string, unknown>).lazy).toBe("[UNREADABLE]");

    // Deep-but-thin structures used to exhaust the JS stack with a RangeError.
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 100_000; i++) deep = { next: deep };
    expect(() => redact(deep)).not.toThrow();

    let deepArr: unknown[] = [];
    for (let i = 0; i < 100_000; i++) deepArr = [deepArr];
    expect(() => redact(deepArr)).not.toThrow();
  });

  test("a shared-reference graph is bounded instead of expanding exponentially", () => {
    // `stack` tracks the current path only, so a value shared between sibling
    // branches is re-walked rather than cut — correct, but it means a
    // deduplicated DAG expands to its tree size. Thirty objects arranged as a
    // diamond are 2^30 nodes; depth 24 measured 23s of blocked event loop on
    // the agent's hot path.
    let dag: Record<string, unknown> = { v: "Bearer abc12345" };
    for (let i = 0; i < 30; i++) dag = { l: dag, r: dag };
    const t0 = performance.now();
    const out = redact(dag);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(JSON.stringify(out)).toContain("[TRUNCATED]");
  });

  test("binary results are summarised, not expanded one key per byte", () => {
    // Object.entries(new Uint8Array(n)) yields n entries, so a binary tool
    // result became an n-key object that emitTrace then JSON.stringify'd:
    // 200 KB measured at 627ms and a multi-megabyte trace body.
    const t0 = performance.now();
    expect(redact(new Uint8Array(200_000))).toBe("[Uint8Array:200000]");
    expect(performance.now() - t0).toBeLessThan(100);
    expect(redact(new ArrayBuffer(64))).toBe("[ArrayBuffer:64]");
  });

  test("Map, Set, Date and Error survive redaction instead of becoming {}", () => {
    // Object.entries returns nothing for any of these, so each redacted to an
    // empty object: the trace recorded {} where the tool had returned an error
    // message, and containsRedaction saw nothing to refuse.
    expect(JSON.stringify(redact(new Map([["password", "p"], ["a", "1"]])))).toContain("[REDACTED]");
    expect(JSON.stringify(redact(new Map([["password", "p"], ["a", "1"]])))).toContain('"1"');
    expect(JSON.stringify(redact(new Set(["Bearer abc123def"])))).toContain("[REDACTED]");
    expect(redact(new Date(0))).toBe("1970-01-01T00:00:00.000Z");

    const err = redact(new Error("Bearer abc123def")) as Record<string, unknown>;
    expect(err.name).toBe("Error");
    expect(err.message).toBe("[REDACTED]");

    expect(containsSecret(new Map([["password", "p"]]))).toBe(true);
    expect(containsSecret(new Set(["Bearer abc123def"]))).toBe(true);
    expect(containsSecret(new Error("Bearer abc123def"))).toBe(true);
  });

  test("a bigint anywhere in a payload stays JSON-serialisable", () => {
    // redact passed bigint straight through, so JSON.stringify threw in
    // sendPost, a bare catch swallowed it, and the trace burned all five
    // retries with no diagnostic. Any tool touching 64-bit database ids.
    const out = redact({ id: 9007199254740993n });
    expect(() => JSON.stringify(out)).not.toThrow();
    expect((out as Record<string, unknown>).id).toBe("9007199254740993");
  });

  test("containsRedaction refuses a subtree the redactor could not fully inspect", () => {
    // "We did not look" is not "there was nothing there", and this gate decides
    // whether a value gets baked into a compiled program as a literal.
    expect(containsRedaction("[TRUNCATED]")).toBe(true);
    expect(containsRedaction("[UNREADABLE]")).toBe(true);
    expect(containsRedaction({ a: { b: "[TRUNCATED]" } })).toBe(true);
    expect(containsRedaction({ a: { b: "ordinary" } })).toBe(false);
  });

  test("containsSecret knows every family the redactor rewrites", () => {
    // containsSecret carried its own hand-copy of the pattern list and had
    // never gained these, so it under-reported the families redact() knew.
    for (const s of [`gho_${"a".repeat(22)}`, `github_pat_${"b".repeat(22)}`, `xoxb-${"1".repeat(12)}`]) {
      expect(containsSecret(s)).toBe(true);
      expect(redactString(s)).toBe("[REDACTED]");
    }
    expect(containsSecret("nothing to see here")).toBe(false);
  });

  test("redact keeps a literal __proto__ key as data", () => {
    // `out[k] = …` ran the inherited setter instead of adding a key, so the
    // key vanished from the trace and the payload's object became the
    // prototype of the redacted result.
    const payload = JSON.parse('{"__proto__":{"polluted":true},"keep":"yes"}') as Record<string, unknown>;
    const red = redact(payload) as Record<string, unknown>;
    expect(Object.getPrototypeOf(red)).toBe(Object.prototype);
    expect(Object.getOwnPropertyNames(red)).toEqual(["__proto__", "keep"]);
    expect((red as { polluted?: unknown }).polluted).toBeUndefined();
  });

  test("redact expands shared references instead of collapsing them", () => {
    const shared = { name: "bug", nested: { k: "v" } };
    const red = redact({ a: shared, b: shared }) as Record<string, unknown>;
    expect(red.a).toEqual({ name: "bug", nested: { k: "v" } });
    // Reachable twice is not a cycle. Collapsing the second branch would delete
    // real data from the trace before it ever reaches the compiler.
    expect(red.b).toEqual({ name: "bug", nested: { k: "v" } });
  });

  test("canonicalize is insensitive to reference sharing", () => {
    const shared = { n: 1, deep: { k: "v" } };
    // Deeply equal values must produce identical canonical forms whether or not
    // they happen to be the same object; hashes and agreement() depend on it.
    expect(canonicalize({ a: shared, b: shared })).toBe(
      canonicalize({ a: { n: 1, deep: { k: "v" } }, b: { n: 1, deep: { k: "v" } } }),
    );
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(canonicalize(cyclic)).toBe('{"a":1,"self":"$cycle"}');
  });

  test("containsRedaction finds the sentinel at depth", () => {
    expect(containsRedaction({ headers: { authorization: "[REDACTED]" } })).toBe(true);
    expect(containsRedaction([{ a: 1 }, { b: ["[REDACTED]"] }])).toBe(true);
    expect(containsRedaction({ a: 1, b: ["fine", { c: null }] })).toBe(false);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(containsRedaction(cyclic)).toBe(false);
  });

  test("flatten expands a value reachable by two paths", () => {
    const label = { id: 7, name: "bug" };
    const paths = [...flatten({ first: label, second: label }).keys()];
    // Without both sub-trees, producersFor() cannot see that an argument came
    // from `second.id`, and a determinable slot degrades into a refusal.
    expect(paths).toContain("first.id");
    expect(paths).toContain("second.id");
    expect(paths).toContain("second.name");
  });

  test("getPath rejects prototype paths and invalid dots", () => {
    expect(getPath({ x: 1 }, "__proto__")).toBeUndefined();
    expect(getPath({ a: { b: 1 } }, "a..b")).toBeUndefined();
    expect(getPath({ a: { b: 1 } }, "a.b")).toBe(1);
  });

  test("envelope values must be arrays", () => {
    const p = mini();
    p.contract.envelope = { inputs: { id: "T-1" as unknown as unknown[] } };
    const issues = validateProgram(p);
    expect(issues.some((i) => i.message.includes("array"))).toBe(true);
    expect(inDistribution({ ...p, contract: { ...p.contract, envelope: { inputs: { id: "T-1" as unknown as unknown[] } } } }, { id: "T-1" })).toBe(false);
  });
});
