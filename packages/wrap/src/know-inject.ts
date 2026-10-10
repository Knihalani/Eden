import { alreadyInjected, injectFromRequest, injectNote, KNOW_INJECT_MARK } from "../../know/src/inject";
import { placePathsFrom, processMemory } from "../../../src/index";
import { memoryConsent } from "../../../src/memory-consent";
import { messageText } from "./intent";
import { injectBodyThenObserveTools, observeToolTraces, stripUpstreamPlaceFields } from "./tool-observe";

function toolNames(body: { tools?: unknown }): string[] {
  const tools = body.tools;
  if (!Array.isArray(tools)) return [];
  const out: string[] = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    const fn = o.function as { name?: string } | undefined;
    const n = typeof fn?.name === "string" ? fn.name : typeof o.name === "string" ? o.name : "";
    if (n) out.push(n);
  }
  return out;
}

function argsOf(x: Record<string, unknown>, fn?: { arguments?: string; input?: unknown }): string {
  if (typeof fn?.arguments === "string") return fn.arguments;
  if (typeof x.arguments === "string") return x.arguments;
  if (typeof x.input === "string") return x.input;
  if (fn && "input" in fn) return JSON.stringify(fn.input ?? "");
  return JSON.stringify(x.arguments ?? x.input ?? "");
}

function toolCalls(messages: unknown[]): { name: string; args: string }[] {
  const out: { name: string; args: string }[] = [];
  for (const m of messages.slice(-4)) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    if (Array.isArray(o.tool_calls)) {
      for (const c of o.tool_calls) {
        if (!c || typeof c !== "object") continue;
        const x = c as Record<string, unknown>;
        const fn = x.function as { name?: string; arguments?: string } | undefined;
        const name = fn?.name || (typeof x.name === "string" ? x.name : "");
        if (name) out.push({ name, args: argsOf(x, fn) });
      }
    }
    if (Array.isArray(o.content)) {
      for (const b of o.content) {
        if (!b || typeof b !== "object") continue;
        const x = b as Record<string, unknown>;
        if (x.type === "tool_use" && typeof x.name === "string") out.push({ name: x.name, args: argsOf(x) });
      }
    }
  }
  return out;
}

export function withKnowFacts(body: Record<string, unknown>): Record<string, unknown> {
  try {
    if (memoryConsent() === "off") return body;
    return injectBodyThenObserveTools(processMemory(), body);
  } catch {
    return body;
  }
}

/**
 * The Anthropic wrap: a turn's memory packet and Know card go at the tail of its human message, never into `system`
 * (D29), where a new packet would invalidate the cached conversation. `inject` keeps them there for every later
 * request of the conversation and encodes what the request adds.
 */
export function withKnowFactsAnthropic(body: {
  system?: string | Array<{ type: string; text?: string; cache_control?: { type: "ephemeral" } }>;
  messages?: unknown[];
  tools?: unknown[];
}): typeof body {
  try {
    if (memoryConsent() === "off") return body;
    const mem = processMemory();
    const messages = body.messages ?? [];
    const knowCard = () => {
      const sys =
        typeof body.system === "string" ? body.system : (body.system ?? []).map((b) => b.text || "").join("\n");
      const blob = `${sys}\n${messageText(messages)}`;
      if (alreadyInjected(blob)) return undefined;
      const card = injectFromRequest({ text: blob, tools: toolNames(body), calls: toolCalls(messages) });
      return card ? injectNote(card) : undefined;
    };
    const next = mem.inject(messages, {
      paths: placePathsFrom(body),
      extra: knowCard,
      extraMarks: [KNOW_INJECT_MARK],
      blocks: true,
    });
    observeToolTraces(mem, body.messages);
    return stripUpstreamPlaceFields(next === messages ? body : { ...body, messages: next }) as typeof body;
  } catch {
    return body;
  }
}
