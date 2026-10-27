import { envHasSecrets, PLACEHOLDER_ENV, setupPrompt } from "./prompt-text";
import { expect, test } from "bun:test";

const filled = { org: "org_live", key: "eden_live", url: "https://eden.example" };

test("default prompt tells the agent to use env placeholders", () => {
  const text = setupPrompt(PLACEHOLDER_ENV);
  expect(text).toContain("Wrap its tools with Eden");
  expect(text).toContain("Do not start a new app");
  expect(text).toContain("Find the tools object");
  expect(text).toContain("@eden/wrap");
  expect(text).toContain("baseUrl: process.env.EDEN_BASE_URL");
  expect(text).toContain("wrap_tools");
  expect(text).toContain("fail-open");
  expect(text).toContain("as placeholders");
  expect(text).toContain("Do not invent real values");
  expect(text).toContain("EDEN_ORG=your_org");
  expect(text).toContain("EDEN_API_KEY=your_key");
  expect(text).toContain("EDEN_BASE_URL=your_url");
  expect(text).not.toContain("org_live");
  expect(envHasSecrets(PLACEHOLDER_ENV)).toBe(false);
  expect(envHasSecrets({ ...PLACEHOLDER_ENV, org: "org_live" })).toBe(true);
});

test("filled prompt is the same instructions with real env values", () => {
  const text = setupPrompt(filled);
  const base = setupPrompt(PLACEHOLDER_ENV).split("## Env")[0];
  expect(text.split("## Env")[0]).toBe(base);
  expect(text).toContain("baseUrl: process.env.EDEN_BASE_URL");
  expect(text).toContain("wrap_tools");
  expect(text).not.toContain("as placeholders");
  expect(text).toContain("EDEN_ORG=org_live");
  expect(text).toContain("EDEN_API_KEY=eden_live");
  expect(text).toContain("EDEN_BASE_URL=https://eden.example");
  expect(envHasSecrets(filled)).toBe(true);
});
