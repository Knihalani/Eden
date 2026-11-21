export {
  DEFAULT_WAIT_MS,
  EdenClient,
  edenId,
  redactUrls,
  type EdenClientOptions,
  type PushedItem,
  type SourceChange,
} from "./client";
export { defaultOnError, edenEnv, fixFor, type EdenEnv } from "./on-error";
export { findLocalBinary, LocalEden, resolveLocalEden, type LocalEdenOptions } from "./local";
export {
  createLocalSurface,
  envOf,
  MAX_KEPT_BYTES,
  MAX_SEEN,
  textOf,
  type LocalSurface,
  type LocalSurfaceOptions,
  type SurfaceSession,
  type TextBlock,
} from "./surface";
export { guardTool, guardTools, type Checker, type GuardOptions } from "./guard";
export { heldResult, withContext, withSources, type ChatMessageLike } from "./messages";
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
