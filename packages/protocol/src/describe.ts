/**
 * How Eden describes its `ask_context` tool to an agent: the MCP server gives one of these, the client SDK exports
 * them for a tenant that registers `ask` as a tool of its own, and the lab's A/Bs read them from here, so what is
 * measured is what ships.
 */

/** The standard description: ask for a fact about the user that the conversation lacks. */
export const ASK_CONTEXT_DESCRIPTION =
  "Ask the user's context partner a question. It searches the user's connected sources (mail, calendar, " +
  "documents, CRM and more) and answers with citations. Use it when you need a fact about the user, their " +
  "people, projects or history that is not in the conversation.";

/**
 * The guided description (D88, docs/research/edge-ask.md), given with `askGuard`: before acting, ask what could block
 * or change the action, naming what it involves; raise only what the answer shows, and go ahead when it says nothing
 * binds. Measured with a guard on Eden's side, which says plainly when its sources hold nothing that binds: without
 * it the guided agent grew more cautious (docs/research/path-to-90.md).
 */
export const ASK_CONTEXT_GUIDED =
  ASK_CONTEXT_DESCRIPTION +
  " Before you act on a request, ask it what could block, constrain or change the action: rules, limits, approvals, " +
  "holds, people's availability, recent changes or things already done. Name the people, organisations, systems, " +
  "places, dates and amounts involved. Raise only what its answer shows; when it says nothing binds, go ahead.";
