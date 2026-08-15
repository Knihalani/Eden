/**
 * Forward console + process logging to Eden as `event_type: log` events.
 */

import { getDefaultClient } from "./client.js";
import { randomId } from "./ids.js";

let _installed = false;
const _originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

function emitLog(level: string, args: unknown[]): void {
  const client = getDefaultClient();
  const config = client.getConfig();
  const message = args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
  client.emit({
    eventId: `log_${randomId()}`,
    tenantId: config.orgId ?? "default",
    projectId: config.projectId,
    traceId: randomId(),
    realm: config.realm,
    eventType: "log",
    timestamp: new Date().toISOString(),
    name: "console",
    sourceFormat: "eden-sdk-logging",
    payload: { message },
    attributes: {
      level,
      logger: "console",
    },
    tags: [`level:${level}`],
  });
}

export function installLogging(): void {
  if (_installed) return;
  console.log = (...args: unknown[]) => {
    emitLog("info", args);
    _originalConsole.log(...args);
  };
  console.info = (...args: unknown[]) => {
    emitLog("info", args);
    _originalConsole.info(...args);
  };
  console.warn = (...args: unknown[]) => {
    emitLog("warn", args);
    _originalConsole.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    emitLog("error", args);
    _originalConsole.error(...args);
  };
  console.debug = (...args: unknown[]) => {
    emitLog("debug", args);
    _originalConsole.debug(...args);
  };
  _installed = true;
}

export function uninstallLogging(): void {
  if (!_installed) return;
  console.log = _originalConsole.log;
  console.info = _originalConsole.info;
  console.warn = _originalConsole.warn;
  console.error = _originalConsole.error;
  console.debug = _originalConsole.debug;
  _installed = false;
}
