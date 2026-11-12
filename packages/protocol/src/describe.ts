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
 * D1252 (F11, trial; the lab's `+askfirst`): `ask_context` described as the agent's first, fast search. Eden answers
 * from its local index of every connected source in milliseconds, where each of the agent's own per-source searches
 * is a connector call (0.3–2 s and, on paid connector plans, money). It says when to fall back to a source's own
 * tool, so the agent does not stop searching where the answer is short (D257's lesson).
 */
export const ASK_CONTEXT_DESCRIPTION_FIRST =
  "Search all of the user's connected sources (mail, calendar, documents, CRM, chat and more) at once. It answers " +
  "in milliseconds from a local index, with citations, and says which sources it searched. Call it first, before " +
  "any per-source search tool, whenever the request depends on the user's own data; one question can cover " +
  "several sources. Use a per-source search tool only for what its answer does not cover.";

/**
 * D1253 (F11, trial; the lab's `+askguide`): one line for a tenant's system prompt, beside the per-source search tools
 * it already gives its agent. Measured (D1252's run): after a packet the agent answers without searching, but on a turn
 * Eden stayed silent it searches its connectors and ignores `ask_context`, whatever the tool's description says. The
 * line routes that lookup to Eden's local index first; connector tools stay for what the answer lacks.
 */
export const ASK_FIRST_GUIDE =
  "To look up anything in the user's own data, call ask_context first: it searches all their connected sources at " +
  "once, in milliseconds. Call a per-source search tool only for something its answer does not cover.";
