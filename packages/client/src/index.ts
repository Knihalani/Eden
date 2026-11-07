export {
  DEFAULT_WAIT_MS,
  EdenClient,
  edenId,
  type EdenClientOptions,
  type PushedItem,
  type SourceChange,
} from "./client";
export { heldResult, withContext, type ChatMessageLike } from "./messages";
// The description Eden recommends for `ask` registered as the agent's tool.
export { ASK_CONTEXT_DESCRIPTION, ASK_QUESTION_DESCRIPTION } from "@eden/protocol";
export type {
  ActionCheck,
  AgentEvent,
  AskResponse,
  ExplainedDecision,
  ExplainResponse,
  Injection,
  ObserveResult,
  SourceChangedReason,
  SourceChangedResult,
} from "@eden/protocol";
