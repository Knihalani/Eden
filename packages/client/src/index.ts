export {
  DEFAULT_WAIT_MS,
  EdenClient,
  edenId,
  redactUrls,
  type EdenClientOptions,
  type PushedItem,
  type SourceChange,
} from "./client";
export { guardTool, guardTools, type Checker, type GuardOptions } from "./guard";
export { heldResult, withContext, type ChatMessageLike } from "./messages";
// The description Eden recommends for `ask` registered as the agent's tool.
export { ASK_CONTEXT_DESCRIPTION } from "@eden/protocol";
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
