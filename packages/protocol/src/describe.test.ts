import { expect, test } from "bun:test";
import { ASK_CONTEXT_DESCRIPTION, ASK_QUESTION_DESCRIPTION } from "./index";

test("the ask tool's description says when to ask as before D335, and only then how to word the question", () => {
  // D257: nothing in it may make the agent ask less; D335 changed only the question's shape.
  const when =
    "Use it when you need a fact about the user, their people, projects or history that is not in the conversation.";
  expect(ASK_CONTEXT_DESCRIPTION).toContain(when);
  const added = ASK_CONTEXT_DESCRIPTION.slice(ASK_CONTEXT_DESCRIPTION.indexOf(when) + when.length);
  expect(added).toContain("few words");
  expect(added).not.toMatch(/only|already|avoid|instead|unless|rarely/i);
  expect(ASK_QUESTION_DESCRIPTION).toContain("few words");
});
