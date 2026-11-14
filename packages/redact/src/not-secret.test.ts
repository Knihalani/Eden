/**
 * D1850: the values the keyword rules and the assignment pass leave (not-secret.ts), each shape beside a real secret
 * of the nearest shape that is still redacted. Secret-shaped values are assembled from parts, so no literal in this
 * file is one.
 */
import { describe, expect, test } from "bun:test";
import { notSecret, placeholderToken } from "./not-secret.ts";
import { redact, redactString } from "./redact.ts";
import { sanitizeForStore } from "./secrets.ts";

/** Each shape: code that is left as it is, and a secret of the nearest shape that is still redacted. */
const SHAPES: [shape: string, left: string, caught: string, secret: string][] = [
  ["a type", "  apiKey: string;", `  apiKey: str${"1ng"}Pass;`, `str${"1ng"}Pass`],
  ["a generic type", "  tokens: Set<number>;", `  token: Set${"<"}x>9Kq2;`, `Set${"<"}x>9Kq2`],
  ["a typed array", "  secret: Uint8Array,", `  secret: Uint8${"Arr"}ay77x,`, `Uint8${"Arr"}ay77x`],
  [
    "a member chain on a known receiver",
    "const apiKey = process.env.EDEN_API_KEY;",
    `const apiKey = proc${"ess"}env9Kq;`,
    `proc${"ess"}env9Kq`,
  ],
  ["this.…", "    this.apiKey = this.options.apiKey;", `    this.apiKey = "dragon.${"fire99"}";`, `dragon.${"fire99"}`],
  ["a usage count", "  inputTokens: res.usage.inputTokens,", `  token: re${"s"}9.usage.x,`, `re${"s"}9.usage.x`],
  ["a template reference", 'password: "${DB_PASSWORD}"', `password: "$${"{"}hunter22`, `$${"{"}hunter22`],
  ["a shell variable", "export API_KEY=$EDEN_API_KEY", `export API_KEY=$ALES${"2024"}`, `$ALES${"2024"}`],
  ["a command", "TOKEN=$(openssl rand -hex 24)", `TOKEN=$${"x"}Kq2pd8sZ`, `$${"x"}Kq2pd8sZ`],
  ["a placeholder in angle brackets", "API_KEY=<your-key>", `API_KEY=<9${"Kq"}2pd8sZ>`, `<9${"Kq"}2pd8sZ>`],
  ["a number as code groups it", "const maxTokens = 2_000;", `password = 2${"000"}48;`, `2${"000"}48`],
  ["a mask", 'password: "xxxxxxxx"', `password: "xxxx${"Kq2p"}"`, `xxxx${"Kq2p"}`],
  ["a run", `apiKey: "AIza${"a".repeat(35)}"`, `apiKey: "${"a".repeat(15)}Hunter2"`, `${"a".repeat(15)}Hunter2`],
];

describe("code and placeholders are left, the nearest secrets are not (D1850)", () => {
  for (const [shape, left, caught, secret] of SHAPES) {
    test(shape, () => {
      expect(sanitizeForStore(left)).toBe(left);
      expect(sanitizeForStore(caught)).not.toContain(secret);
    });
  }

  test("a plain word, a short value, a digit run, a call, upper case and changeme stay redacted", () => {
    for (const value of ["sunshine", "hunter2", "84729163", "find(x)", "COUNT_ME_IN", "changeme", "s.input"]) {
      expect([value, notSecret(value)]).toEqual([value, false]);
      expect(sanitizeForStore(`the password is ${value}`)).not.toContain(value);
    }
  });

  test("one token only: a quoted value with a space or a quote inside is never excused", () => {
    expect(notSecret(`'process.env.TOKEN"API key: ${"ZC0u"}WJFi'`)).toBe(false);
    expect(notSecret("process.env.TOKEN")).toBe(true);
    expect(notSecret('"process.env.TOKEN"')).toBe(true);
  });

  test("placeholder key ids and tokens: a run or a mask fills the rest of the value", () => {
    expect(placeholderToken(`AKIA${"X".repeat(16)}`)).toBe(true);
    expect(placeholderToken(`hf_${"x".repeat(30)}`)).toBe(true);
    expect(placeholderToken(`AKIA${"QQQQRRRR".repeat(2)}`)).toBe(false);
    expect(sanitizeForStore(`id ${"AK" + "IA"}${"X".repeat(16)} is a placeholder`)).toContain("XXXX");
    expect(sanitizeForStore(`id ${"AK" + "IA"}${"QQQQRRRR".repeat(2)} is set`)).not.toContain("QQQQRRRR");
  });

  test("the structural pass leaves them too, standalone", () => {
    expect(redactString("const x = { maxTokens: 2_000, apiKey: process.env.KEY };")).toBe(
      "const x = { maxTokens: 2_000, apiKey: process.env.KEY };",
    );
    expect(redactString(`apiKey: "${"Kq2pd8"}sZx9"`)).toBe("apiKey: [REDACTED]");
    expect(redact({ password: "hunter22", note: "token: string" })).toEqual({
      password: "[REDACTED]",
      note: "token: string",
    });
  });
});
