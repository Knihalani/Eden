import { expect, test } from "bun:test";
import { ASK_CONTEXT_DESCRIPTION, ASK_CONTEXT_DESCRIPTION_TERSE, ASK_QUESTION_TERSE } from "./index";

test("the terse trial description keeps the standard one's licence to ask, word for word (D335, D257)", () => {
  // Only the question's shape may change: when to ask is the standard description itself.
  expect(ASK_CONTEXT_DESCRIPTION_TERSE.startsWith(ASK_CONTEXT_DESCRIPTION)).toBe(true);
  const added = ASK_CONTEXT_DESCRIPTION_TERSE.slice(ASK_CONTEXT_DESCRIPTION.length);
  expect(added).toContain("few words");
  // Nothing that tells the agent to ask less, or that Eden already found everything.
  expect(added).not.toMatch(/only|already|avoid|instead|unless|rarely/i);
  expect(ASK_QUESTION_TERSE).toContain("few words");
});
