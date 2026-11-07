/**
 * How Eden describes its `ask_context` tool to an agent: the MCP server gives it, the client SDK exports it for a
 * tenant that registers `ask` as a tool of its own, and the lab's A/Bs read it from here, so what is measured is what
 * ships.
 */

/**
 * The standard description: ask for a fact about the user that the conversation lacks, written like a search. The
 * question's shape was promoted from a trial (A16, D335): on Pi a turn that asked was ~190 output tokens (a sentence to
 * the user, ~39 tokens a call, a ~144-character question); asked for a few words, questions fell to ~45 characters and
 * a turn that asks to ~155 tokens, the agent asked a little more often, and a task cost the same one request at a time
 * and $0.016 per 1,000 less over a user's days, 0.09 s faster (docs/research/a16-loop.md). When to ask is unchanged
 * (D257: nothing may make the agent skip an ask).
 */
export const ASK_CONTEXT_DESCRIPTION =
  "Ask the user's context partner a question. It searches the user's connected sources (mail, calendar, " +
  "documents, CRM and more) and answers with citations. Use it when you need a fact about the user, their " +
  "people, projects or history that is not in the conversation. Write the question like a search, in a few words " +
  'naming the person, thing or date ("Dana Lee email address", "dentist booking 12 March").';

/** The description of `ask_context`'s one parameter, `question` (D335). */
export const ASK_QUESTION_DESCRIPTION = "What to look up, in a few words: the person, thing or date, as in a search.";
