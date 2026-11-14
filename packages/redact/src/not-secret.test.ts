/**
 * D1850: the values the keyword rules and the assignment pass leave (not-secret.ts), each shape beside a real secret
 * of the nearest shape that is still redacted. Secret-shaped values are assembled from parts, so no literal in this
 * file is one.
 */
import { describe, expect, test } from "bun:test";
import { notSecret, placeholderToken } from "./not-secret.ts";
import { redact, redactAssignments, redactString } from "./redact.ts";
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
  ["a template reference", 'password: "${DB_PASSWORD}"', `password: "$${"{"}DB:-hunter22}"`, `hunter22`],
  [
    "an environment variable on env",
    "  apiKey: env.OPENROUTER_API_KEY,",
    `  apiKey: env.Hunt${"3r2"}Pass,`,
    `Hunt3r2Pass`,
  ],
  ["a camelCase interpolation", 'token: "${accessToken}"', `token: "$${"{"}Hunter2Pass}"`, `Hunter2Pass`],
  ["a shell variable", "export API_KEY=$EDEN_API_KEY", `export API_KEY=$ALES${"2024"}`, `$ALES${"2024"}`],
  [
    "a variable then more",
    "export API_KEY=$EDEN_API_KEY",
    `export API_KEY=$EDEN_API_KEY/${"Kq2pd8"}sZx9`,
    `Kq2pd8sZx9`,
  ],
  ["a placeholder in angle brackets", "API_KEY=<your-key>", `API_KEY=<Xk39${"dKf"}93kdKf8>`, `Xk39dKf93kdKf8`],
  ["a template expression", "secret: {{vault_secret}}", `secret: {{x}}${"Kq2pd8"}sZx9`, `Kq2pd8sZx9`],
  ["a mask", 'password: "xxxxxxxx"', `password: "xxxx${"Kq2p"}"`, `xxxx${"Kq2p"}`],
  ["a run", `apiKey: "AIza${"a".repeat(35)}"`, `apiKey: "${"a".repeat(15)}Hunter2"`, `${"a".repeat(15)}Hunter2`],
  [
    "a run after a letter prefix",
    `apiKey: "AIza${"a".repeat(35)}"`,
    `apiKey: "Xk39${"dKf"}93kdK${"a".repeat(16)}"`,
    `Xk39dKf93kdK`,
  ],
];

describe("code and placeholders are left, the nearest secrets are not (D1850)", () => {
  for (const [shape, left, caught, secret] of SHAPES) {
    test(shape, () => {
      expect(sanitizeForStore(left)).toBe(left);
      expect(sanitizeForStore(caught)).not.toContain(secret);
    });
  }

  test("a plain word, a short value, a digit run, a call, upper case and changeme stay redacted", () => {
    for (const value of ["sunshine", "hunter2", "84729163", "find(x)", "COUNT_ME_IN", "changeme", "s.input", "2_000"]) {
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

  test("the public structural pass excuses nothing unless asked, as main (the review of 2026-11-14)", () => {
    expect(redactString("const x = { apiKey: process.env.EDEN_KEY };")).toBe("const x = { apiKey: [REDACTED] };");
    expect(redactAssignments("const x = { apiKey: process.env.EDEN_KEY };", true)).toBe(
      "const x = { apiKey: process.env.EDEN_KEY };",
    );
    expect(redact({ password: "hunter22", note: "token: string" })).toEqual({
      password: "[REDACTED]",
      note: "token: [REDACTED]",
    });
  });
});
