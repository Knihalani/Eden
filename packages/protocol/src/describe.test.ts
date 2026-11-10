import { expect, test } from "bun:test";
import {
  ASK_CONTEXT_DESCRIPTION,
  ASK_CONTEXT_MULTI_DESCRIPTION,
  ASK_MULTI_MAX,
  askQuestions,
  joinAnswers,
} from "./describe";

test("askMulti's description keeps the sentence on when to ask word for word (D485, D335)", () => {
  const when =
    "Use it when you need a fact about the user, their people, projects or history that is not in the conversation.";
  expect(ASK_CONTEXT_DESCRIPTION).toContain(when);
  expect(ASK_CONTEXT_MULTI_DESCRIPTION).toContain(when);
  expect(ASK_CONTEXT_MULTI_DESCRIPTION).toContain("one or more questions");
});

test("askQuestions reads a list, one string, or the single-question arguments", () => {
  expect(askQuestions({ questions: ["who is Ilse?", " ", "when is the review?"] })).toEqual([
    "who is Ilse?",
    "when is the review?",
  ]);
  expect(askQuestions({ questions: "who is Ilse?" })).toEqual(["who is Ilse?"]);
  expect(askQuestions({ question: "who is Ilse?" })).toEqual(["who is Ilse?"]);
  expect(askQuestions({ query: "who is Ilse?" })).toEqual(["who is Ilse?"]);
  expect(askQuestions({})).toEqual([]);
  expect(askQuestions(null)).toEqual([]);
  expect(askQuestions({ questions: Array(9).fill("q") })).toHaveLength(ASK_MULTI_MAX);
});

test("joinAnswers leaves one answer as it is and heads several with their questions, on one line each", () => {
  expect(joinAnswers([{ question: "q", text: "the answer" }])).toBe("the answer");
  expect(joinAnswers([])).toBe("");
  expect(
    joinAnswers([
      { question: "who is\nIlse?", text: "A buyer." },
      { question: "when?", text: "Friday." },
    ]),
  ).toBe("Question 1: who is Ilse?\nA buyer.\n\nQuestion 2: when?\nFriday.");
});
