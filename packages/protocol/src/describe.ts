/**
 * How Eden describes its `ask_context` tool to an agent: the MCP server gives it, the client SDK exports it for a
 * tenant that registers `ask` as a tool of its own, and the lab's A/Bs read it from here, so what is measured is what
 * ships.
 */

/** The standard description: ask for a fact about the user that the conversation lacks. */
export const ASK_CONTEXT_DESCRIPTION =
  "Ask the user's context partner a question. It searches the user's connected sources (mail, calendar, " +
  "documents, CRM and more) and answers with citations. Use it when you need a fact about the user, their " +
  "people, projects or history that is not in the conversation.";

/**
 * Trial (A16, D335; owner: repo owner; ends 2026-12-07): the same tool, described so that the agent's turn that asks
 * costs fewer output tokens. On Pi a turn that asks is ~190 output tokens: a sentence telling the user it will look
 * (~50), each call's own overhead (~39) and a full-sentence question (~144 characters, ~57 tokens), 1.5 calls a turn
 * (docs/research/a16-loop.md). It says when to ask exactly as the standard description does (D257: nothing may make
 * the agent skip an ask); only the question's shape changes. (A first wording also asked for one call per thing and
 * no narration: Haiku kept narrating and made more calls, 1.9 a turn against 1.6.) Promoted, it replaces
 * `ASK_CONTEXT_DESCRIPTION`; rejected, it is deleted with the lab's `+terse` flag.
 */
export const ASK_CONTEXT_DESCRIPTION_TERSE =
  "Ask the user's context partner a question. It searches the user's connected sources (mail, calendar, " +
  "documents, CRM and more) and answers with citations. Use it when you need a fact about the user, their " +
  "people, projects or history that is not in the conversation. Write the question like a search, in a few words " +
  'naming the person, thing or date ("Dana Lee email address", "dentist booking 12 March").';

/** Trial (D335): the description of `ask_context`'s one parameter under `ASK_CONTEXT_DESCRIPTION_TERSE`. */
export const ASK_QUESTION_TERSE = "What to look up, in a few words: the person, thing or date, as in a search.";
