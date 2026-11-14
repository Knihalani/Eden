/**
 * Resources and prompts (D1860), as functions over `McpClient.request` rather than methods on it, so a program that
 * calls only tools (Eden) never loads this file. Each result is shape-checked as the client checks a tool listing:
 * the fields named in its type are there and of their type, or the call rejects; everything else in it is the
 * server's data, returned as sent and untrusted. A listing is one page (`nextCursor` for the next) and its reply is
 * capped as a `tools/list` page is (4 MiB on HTTP).
 */
import type { McpClient, RequestOptions } from "./client";

/** A resource as `resources/list` describes it. */
export interface Resource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  [key: string]: unknown;
}

/** A parameterized resource (`resources/templates/list`): `uriTemplate` is an RFC 6570 template. */
export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
  [key: string]: unknown;
}

/** One body of a read resource: `text`, or `blob` (base64). */
export interface ResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  [key: string]: unknown;
}

/** A prompt as `prompts/list` describes it. */
export interface Prompt {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean; [key: string]: unknown }[];
  [key: string]: unknown;
}

/** One message of a prompt (`prompts/get`); `content` is a content block as in a tool result. */
export interface PromptMessage {
  role: "user" | "assistant";
  content: { type: string; text?: string; [key: string]: unknown };
  [key: string]: unknown;
}

type Page = { cursor?: string };

export async function listResources(
  client: McpClient,
  params?: Page,
  options?: RequestOptions,
): Promise<{ resources: Resource[]; nextCursor?: string }> {
  const r = await client.request("resources/list", cursorOf(params), options);
  return { resources: listOf(r.resources, "resources/list", ["uri", "name"]) as Resource[], ...next(r) };
}

export async function listResourceTemplates(
  client: McpClient,
  params?: Page,
  options?: RequestOptions,
): Promise<{ resourceTemplates: ResourceTemplate[]; nextCursor?: string }> {
  const r = await client.request("resources/templates/list", cursorOf(params), options);
  const list = listOf(r.resourceTemplates, "resources/templates/list", ["uriTemplate", "name"]);
  return { resourceTemplates: list as ResourceTemplate[], ...next(r) };
}

export async function readResource(
  client: McpClient,
  params: { uri: string },
  options?: RequestOptions,
): Promise<{ contents: ResourceContents[] }> {
  const r = await client.request("resources/read", { uri: params.uri }, options);
  const contents = listOf(r.contents, "resources/read", ["uri"]) as ResourceContents[];
  for (const c of contents) {
    if ((c.text !== undefined && typeof c.text !== "string") || (c.blob !== undefined && typeof c.blob !== "string")) {
      throw new Error("Server sent an invalid resources/read result");
    }
  }
  return { contents };
}

export async function listPrompts(
  client: McpClient,
  params?: Page,
  options?: RequestOptions,
): Promise<{ prompts: Prompt[]; nextCursor?: string }> {
  const r = await client.request("prompts/list", cursorOf(params), options);
  const prompts = listOf(r.prompts, "prompts/list", ["name"]) as Prompt[];
  for (const p of prompts) {
    if (p.arguments !== undefined) listOf(p.arguments, "prompts/list", ["name"]);
  }
  return { prompts, ...next(r) };
}

export async function getPrompt(
  client: McpClient,
  params: { name: string; arguments?: Record<string, string> },
  options?: RequestOptions,
): Promise<{ description?: string; messages: PromptMessage[] }> {
  const r = await client.request("prompts/get", { ...params }, options);
  const messages = listOf(r.messages, "prompts/get", []) as PromptMessage[];
  for (const m of messages) {
    if ((m.role !== "user" && m.role !== "assistant") || !isObject(m.content) || typeof m.content.type !== "string") {
      throw new Error("Server sent an invalid prompts/get result");
    }
  }
  return { ...(typeof r.description === "string" ? { description: r.description } : {}), messages };
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

function cursorOf(params?: Page): Record<string, unknown> | undefined {
  return params?.cursor ? { cursor: params.cursor } : undefined;
}

function next(r: Record<string, unknown>): { nextCursor?: string } {
  return typeof r.nextCursor === "string" ? { nextCursor: r.nextCursor } : {};
}

/** `x` as an array of objects each with string `fields`, or a rejection naming the method. */
function listOf(x: unknown, method: string, fields: string[]): Record<string, unknown>[] {
  if (!Array.isArray(x) || !x.every((o) => isObject(o) && fields.every((f) => typeof o[f] === "string"))) {
    throw new Error(`Server sent an invalid ${method} result`);
  }
  return x as Record<string, unknown>[];
}
