import { describe, expect, test } from "bun:test";
import { sanitizeForStore } from "./secrets";

// Audit A5 (fixed). A multi-word password in quotes under `password` (and, after another credential field, under any
// credential key). KEYWORD_RULE (secrets.ts:88) redacts only `"correct` (`\S{6,}` starts at the quote, stops at the
// space), and the structural pass that would take the whole quoted value then sees the unquoted sentinel and skips it
// (redact.ts:332). Also: a passphrase with spaces as the value of a credential key, in JSON a connector returns. Alone,
// the structural pass (`redact`, scanAssignments) redacts the whole quoted value. After another credential field, the
// keyword rule's span (`\S{6,}` from the first value) runs over the next field's key, so the structural pass no longer
// sees that key and the rest of the passphrase is stored in the clear.
const phrase = ["correct", "horse", "battery", "staple"].join(" ");

describe("audit A5: a quoted multi-word credential is redacted whole", () => {
  test("control: alone, the passphrase is redacted whole", () => {
    expect(sanitizeForStore(`{"passphrase":"${phrase}"}`)).not.toContain("battery");
  });
  test.each([
    `{"password":"${phrase}"}`,
    `user: dana, password: "${phrase}"`,
    `{"secret":"s","password":"${phrase}"}`,
    `{"password":"x1","passphrase":"${phrase}"}`,
    `password: hunter2, passphrase: "${phrase}"`,
    `my password is "${phrase}" for the router`,
  ])("no word of the passphrase survives: %s", (text) => {
    const out = sanitizeForStore(text);
    expect(out).not.toContain("battery");
  });
});

// Audit A20. The A5 fix took a double-quoted value whole, but prose quotes a passphrase in single or typographic
// quotes as often ("my password is 'correct horse battery staple'"), and there the keyword rule still took only
// `'correct`: the rest was stored, indexed and could be quoted back to an agent.
describe("audit A20: a passphrase in single or typographic quotes is redacted whole", () => {
  test.each([
    `my password is '${phrase}' for the router`,
    `the password is “${phrase}” now`,
    `the password is ‘${phrase}’ now`,
    `Wi-Fi password: '${phrase}'`,
  ])("no word of the passphrase survives: %s", (text) => {
    expect(sanitizeForStore(text)).not.toContain("battery");
  });
  test("an apostrophe after the keyword is not read as a quote", () => {
    expect(sanitizeForStore("the password isn't what Dana's team uses")).toContain("Dana's team");
  });
});
