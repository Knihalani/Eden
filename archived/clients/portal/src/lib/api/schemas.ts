/**
 * Runtime Zod schemas for high-traffic portal read-model responses.
 * Wired at the ``fetchApi`` boundary when callers pass ``schema``.
 */
import { z, type ZodType, type ZodTypeAny } from "zod";

export const sessionFixtureSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  userId: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional().nullable(),
  turnCount: z.number(),
  outcome: z.enum(["ok", "error", "mixed"]),
  durationMs: z.number(),
  totalTokens: z.number(),
  costUsd: z.number().nullable(),
  lastErrorSummary: z.string().optional().nullable(),
  diagnosis: z.string().optional().nullable(),
  relatedIssueIds: z.array(z.string()),
  traceIds: z.array(z.string()),
});

export const sessionFixtureListSchema = z.array(sessionFixtureSchema);

export const issueFixtureSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  body: z.string(),
  severity: z.enum(["error", "warn"]),
  status: z.enum(["open", "acknowledged", "resolved", "ignored"]),
  agentId: z.string(),
  fingerprint: z.string(),
  detector: z.string(),
  environment: z.string(),
  occurrenceTraceIds: z.array(z.string()),
  firstSeen: z.string(),
  lastSeen: z.string(),
  signalCount: z.number(),
  relatedSignalId: z.string().optional().nullable(),
  errorSample: z.string(),
  impact: z.string(),
  suggestedFix: z.string(),
  patchBlockedReason: z.string().optional().nullable(),
  patchBlockedMessage: z.string().optional().nullable(),
  tags: z.array(z.string()),
  rankScore: z.number().optional().nullable(),
});

export const issueFixtureListSchema = z.array(issueFixtureSchema);

const transcriptStepSchema = z.object({
  id: z.string(),
  kind: z.enum(["task", "llm", "tool", "bash", "span", "agent", "handoff"]),
  title: z.string(),
  durationMs: z.number(),
  status: z.enum(["ok", "error"]).optional(),
  startedAt: z.string().optional(),
  spanId: z.string().optional(),
  parentId: z.string().optional(),
  agentId: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  tokensIn: z.number().optional(),
  tokensOut: z.number().optional(),
  costUsd: z.number().optional(),
  attributes: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  inputPreview: z.string().optional(),
  outputPreview: z.string().optional(),
  errorMessage: z.string().optional(),
  metadata: z.record(z.string()).optional(),
});

export const traceFixtureSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  participants: z.array(z.string()).optional(),
  name: z.string(),
  status: z.enum(["ok", "error"]),
  startedAt: z.string(),
  durationMs: z.number(),
  tokens: z.number(),
  costUsd: z.number().nullable(),
  severity: z.enum(["error", "warn", "none"]),
  sessionId: z.string().optional().nullable(),
  signals: z.object({
    title: z.string(),
    body: z.string(),
    count: z.number().optional(),
  }),
  steps: z.array(transcriptStepSchema),
  /** W4-6 bookmarks — optional so pre-172 API responses stay valid. */
  isBookmarked: z.boolean().optional(),
});

export const traceFixtureListSchema = z.array(traceFixtureSchema);

export type SessionFixtureValidated = z.infer<typeof sessionFixtureSchema>;
export type IssueFixtureValidated = z.infer<typeof issueFixtureSchema>;
export type TraceFixtureValidated = z.infer<typeof traceFixtureSchema>;

/** Bridge Zod output shapes to portal fixture types at call sites. */
export function portalSchema<T>(schema: ZodTypeAny): ZodType<T, ZodTypeAny, unknown> {
  return schema as ZodType<T, ZodTypeAny, unknown>;
}
