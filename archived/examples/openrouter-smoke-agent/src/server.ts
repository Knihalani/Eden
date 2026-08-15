/**
 * Local HTTP server + dashboard for the OpenRouter smoke agent.
 *
 *   cd examples/openrouter-smoke-agent
 *   npm install
 *   npm start
 *   open http://127.0.0.1:4173
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, type AgentConfig } from "./agent/run.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function envDefaults(): Partial<AgentConfig> & {
  edenBaseUrl: string;
  portalUrl: string;
} {
  return {
    openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
    model: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
    edenOrgId: process.env.EDEN_ORG_ID || "",
    edenApiKey:
      process.env.EDEN_ORG_API_KEY || process.env.EDEN_API_KEY || "",
    edenBaseUrl:
      process.env.EDEN_BASE_URL || "https://api.edenobservability.com",
    edenProjectId:
      process.env.EDEN_PROJECT_ID || "openrouter-smoke-agent",
    portalUrl: "https://edenobservability.com",
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function serveStatic(
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  const safe = pathname === "/" ? "/index.html" : pathname;
  const filePath = join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    const type = MIME[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const method = req.method || "GET";

  try {
    if (method === "GET" && url.pathname === "/api/defaults") {
      const defaults = envDefaults();
      sendJson(res, 200, {
        ...defaults,
        // Never echo full secrets in defaults if present — only whether set.
        openRouterApiKey: defaults.openRouterApiKey,
        edenApiKey: defaults.edenApiKey,
        hasOpenRouterKey: Boolean(defaults.openRouterApiKey),
        hasEdenKey: Boolean(defaults.edenApiKey),
        hasEdenOrg: Boolean(defaults.edenOrgId),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        service: "eden-openrouter-smoke-agent",
        sdk: "@eden-ai/sdk",
        edenBaseUrl: envDefaults().edenBaseUrl,
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/chat") {
      const raw = await readBody(req);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return;
      }

      const message = String(body.message ?? "").trim();
      if (!message) {
        sendJson(res, 400, { error: "message is required" });
        return;
      }

      const defaults = envDefaults();
      const config: AgentConfig = {
        openRouterApiKey: String(
          body.openRouterApiKey ?? defaults.openRouterApiKey ?? "",
        ),
        model: String(body.model ?? defaults.model ?? ""),
        edenOrgId: String(body.edenOrgId ?? defaults.edenOrgId ?? ""),
        edenApiKey: String(body.edenApiKey ?? defaults.edenApiKey ?? ""),
        edenBaseUrl: String(
          body.edenBaseUrl ?? defaults.edenBaseUrl ?? "",
        ),
        edenProjectId: String(
          body.edenProjectId ?? defaults.edenProjectId ?? "",
        ),
        userId: String(body.userId ?? "smoke-tester"),
      };

      try {
        const result = await runAgent(message, config);
        sendJson(res, 200, {
          ok: true,
          ...result,
          portalTracesUrl: `${defaults.portalUrl}/traces`,
        });
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, { ok: false, error: messageText });
      }
      return;
    }

    if (method === "GET") {
      await serveStatic(res, url.pathname);
      return;
    }

    res.writeHead(405).end("Method not allowed");
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { ok: false, error: messageText });
  }
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Eden OpenRouter smoke agent → http://${HOST}:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`Prod Eden ingest default   → ${envDefaults().edenBaseUrl}`);
});
