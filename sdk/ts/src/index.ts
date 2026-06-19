/**
 * Eden TypeScript SDK — AI-native environment generation client.
 *
 * Usage:
 * ```ts
 * import { Eden } from "@eden/sdk";
 *
 * const eden = new Eden({ apiKey: "sk_...", defaultOrg: "org_..." });
 * const job = await eden.jobs.create({ description: "A multi-agent negotiation environment" });
 * console.log(job.job_id);
 * ```
 */

export { EdenClient } from "./client";
export { EdenConfig } from "./config";
export {
  EdenError,
  AuthenticationError,
  RateLimitError,
  QuotaExceededError,
  ValidationError,
  NotFoundError,
  PipelineError,
  SandboxTimeoutError,
  ServerError,
  raiseForStatus,
} from "./errors";
export {
  JobItemSchema,
  JobStatusSchema,
  JobResultSchema,
  JobCreateRequestSchema,
  JobCreateResponseSchema,
  EnvironmentItemSchema,
  EnvironmentDetailSchema,
  EnvironmentVersionSchema,
  EnvironmentTestReportSchema,
  BenchmarkItemSchema,
  BenchmarkRunResultSchema,
  BenchmarkResultDetailSchema,
  BenchmarkHistoryItemSchema,
  StreamEventSchema,
} from "./models";
export type {
  JobItem,
  JobStatus,
  JobResult,
  JobCreateRequest,
  JobCreateResponse,
  EnvironmentItem,
  EnvironmentDetail,
  EnvironmentVersion,
  EnvironmentTestReport,
  BenchmarkItem,
  BenchmarkRunResult,
  BenchmarkResultDetail,
  BenchmarkHistoryItem,
  StreamEvent,
} from "./models";

// Convenience alias
export { EdenClient as Eden } from "./client";

export {
  traceAgent,
  autoInstrument,
  configureTracing,
  type TraceOptions,
  type TraceContext,
} from "./trace";

// App/site-layer integration (Phase A1, 2026-06-19). For server-side
// usage (Next.js route handlers, Node.js, Edge functions).
export {
  EdenApp,
  type EdenAppConfig,
  type FeedbackInput,
  type FeedbackResult,
  type FeedbackValue,
  type PresignedTokenInput,
  type PresignedTokenResult,
  type SessionStartInput,
  type SessionStartResult,
  type SessionSummary,
  type TrackOptions,
} from "./app";
