export { EdenClient, type EdenClientOptions } from "./client";
export { heldResult, withContext, type ChatMessageLike } from "./messages";
// The descriptions Eden recommends for `ask` registered as the agent's tool: the guided one with `askGuard` (D88).
export { ASK_CONTEXT_DESCRIPTION, ASK_CONTEXT_GUIDED } from "@eden/protocol";
export type { ActionCheck, AgentEvent, AskResponse, Injection, ObserveResult } from "@eden/protocol";
