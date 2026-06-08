/**
 * Eden TypeScript SDK — configuration.
 */

export interface EdenConfigOptions {
  apiKey?: string;
  baseUrl?: string;
  defaultOrg?: string;
  timeout?: number;
  maxRetries?: number;
  debug?: boolean;
}

export class EdenConfig {
  apiKey: string | undefined;
  baseUrl: string;
  defaultOrg: string | undefined;
  timeout: number;
  maxRetries: number;
  debug: boolean;

  constructor(options: EdenConfigOptions = {}) {
    this.apiKey = options.apiKey ?? getEnv("EDEN_API_KEY");
    this.baseUrl = options.baseUrl ?? getEnv("EDEN_BASE_URL") ?? "http://localhost:8000";
    this.defaultOrg = options.defaultOrg ?? getEnv("EDEN_DEFAULT_ORG");
    this.timeout = options.timeout ?? 60000;
    this.maxRetries = options.maxRetries ?? 3;
    this.debug = options.debug ?? false;
  }

  getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.apiKey && this.defaultOrg) {
      headers["X-Org-Api-Key"] = this.apiKey;
      headers["X-Org-Id"] = this.defaultOrg;
    }
    return headers;
  }
}

function getEnv(key: string): string | undefined {
  if (typeof process !== "undefined" && process.env) {
    return process.env[key];
  }
  return undefined;
}
