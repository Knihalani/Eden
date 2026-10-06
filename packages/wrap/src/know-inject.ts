import { alreadyInjected, injectFromRequest, injectNote } from "../../know/src/inject";
import { MEMORY_MARK, placePathsFrom, processMemory } from "../../../src/index";
import { MEMORY_PACKET_MARKS } from "../../../src/memory-sota";
import { memoryConsent } from "../../../src/memory-consent";
import { messageText } from "./intent";
import { injectBodyThenObserveTools, observeToolTraces, stripUpstreamPlaceFields } from "./tool-observe";

function toolNames(body: Record<string, unknown>): string[] {
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

function messagesForPlaceInject(messages: unknown[], body: object): unknown[] {
  try {
    const list = Array.isArray(messages) ? messages : [];
    const extra = placePathsFrom(body);
    if (!extra.length) return list;
    let idx = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (!m || typeof m !== "object" || Array.isArray(m)) continue;
      const role = String((m as { role?: unknown }).role ?? "").toLowerCase();
      if (role === "user" || role === "human") {
        idx = i;
        break;
      }
    }
    if (idx < 0) return list;
    const last = list[idx] as Record<string, unknown>;
    const files = [...placePathsFrom(last), ...extra]
      .filter((n, i, a) => a.findIndex((x) => x.toLowerCase() === n.toLowerCase()) === i)
      .slice(0, 8);
    if (!files.length) return list;
    const copy = list.slice();
    copy[idx] = { ...last, files };
    return copy;
  } catch {
    return Array.isArray(messages) ? messages : [];
  }
}

export function withKnowFacts(body: Record<string, unknown>): Record<string, unknown> {
  try {
    if (memoryConsent() === "off") return body;
    return injectBodyThenObserveTools(processMemory(), body);
  } catch {
    return body;
  }
}

export function withKnowFactsAnthropic(body: {
  system?: string | Array<{ type: string; text?: string; cache_control?: { type: "ephemeral" } }>;
  messages?: unknown[];
  tools?: unknown[];
}): typeof body {
  try {
    if (memoryConsent() === "off") return body;
    const sys = typeof body.system === "string" ? body.system : (body.system ?? []).map((b) => b.text || "").join("\n");
    const messages = body.messages ?? [];
    const blob = `${sys}\n${messageText(messages)}`;
    const extras: Array<{ type: "text"; text: string }> = [];
    const mem = processMemory();
    if (alreadyInjected(blob) || MEMORY_PACKET_MARKS.some((mark) => blob.includes(mark))) {
      mem.observe(messages);
      observeToolTraces(mem, body.messages);
      return stripUpstreamPlaceFields(body) as typeof body;
    }
    const injected = mem.inject(messagesForPlaceInject(messages, body));
    for (const m of injected) {
      if (!m || typeof m !== "object") continue;
      const o = m as { role?: string; content?: unknown };
      if (o.role !== "system" || typeof o.content !== "string") continue;
      if (o.content.includes(MEMORY_MARK) || o.content.includes("Eden Know:"))
        extras.push({ type: "text", text: o.content });
    }
    if (!extras.some((e) => e.text.includes("Eden Know:"))) {
      const card = injectFromRequest({
        text: blob,
        tools: toolNames(body as Record<string, unknown>),
        calls: toolCalls(messages),
      });
      if (card) extras.push({ type: "text", text: injectNote(card) });
    }
    observeToolTraces(mem, body.messages);
    if (!extras.length) return stripUpstreamPlaceFields(body) as typeof body;
    if (typeof body.system === "string") {
      return stripUpstreamPlaceFields({
        ...body,
        system: [{ type: "text", text: body.system }, ...extras],
      }) as typeof body;
    }
    return stripUpstreamPlaceFields({
      ...body,
      system: [...(Array.isArray(body.system) ? body.system : []), ...extras],
    }) as typeof body;
  } catch {
    return body;
  }
}
