/**
 * The gate on Node, with Node's own test runner (Node 24 or later strips the types itself):
 *
 *   node --test packages/redact/src/node.check.ts
 *
 * The same public API the Bun suite covers, on secret shapes from each family (assembled from parts, so no literal in
 * this file is one). `node-parity.test.ts` (Bun) compares the two runtimes text for text on fuzz and corpus texts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { REDACTED, redact, redactString, sanitizeForStore, secretHits, warmGate } from "./index.ts";

const GHP = "ghp_" + "a1B2c3D4e5F6g7H8i9J0" + "k1L2m3N4o5P6q7R8";
const AWS_ID = "AKIA" + "Z7QW3RTY5UIOP2LK";
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG" + "/bPxRfiCYzEXAMPLEKEY9";

test("warmGate builds once and leaves results unchanged", () => {
  warmGate();
  warmGate();
  assert.equal(sanitizeForStore("nothing secret here"), "nothing secret here");
});

test("sanitizeForStore keeps the words around each secret", () => {
  assert.equal(
    sanitizeForStore("db: postgres://admin:hunter22@db.internal/app"),
    `db: postgres://admin:${REDACTED}@db.internal/app`,
  );
  assert.equal(sanitizeForStore("the staging password is correct-horse-9"), `the staging password is ${REDACTED}`);
  assert.equal(sanitizeForStore(`export GITHUB_TOKEN=${GHP}`), `export GITHUB_TOKEN=${REDACTED}`);
  const aws = sanitizeForStore(`aws_access_key_id=${AWS_ID}\naws_secret_access_key=${AWS_SECRET}`);
  assert.ok(!aws.includes(AWS_ID) && !aws.includes(AWS_SECRET), aws);
});

test("secretHits names the rules, and none for plain text", () => {
  assert.deepEqual(secretHits(`export GITHUB_TOKEN=${GHP}`), [
    "eden-keyword",
    "eden-legacy-token",
    "generic-api-key",
    "github-pat",
  ]);
  assert.deepEqual(secretHits("Lunch with Dana on Friday, then the quarterly review."), []);
});

test("redact walks JSON values", () => {
  assert.deepEqual(redact({ user: "dana", password: "x", note: "Bearer abc.def" }), {
    user: "dana",
    password: REDACTED,
    note: REDACTED,
  });
  assert.equal(redactString(`token: ${GHP}`), `token: ${REDACTED}`);
});
