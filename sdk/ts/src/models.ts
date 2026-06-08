/**
 * Eden TypeScript SDK — Zod-validated models.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Meta / Envelope
// ---------------------------------------------------------------------------

export const APIMetaSchema = z.object({
  api_version: z.string(),
  request_id: z.string(),
  timestamp: z.string(),
});

export const PaginatedMetaSchema = APIMetaSchema.extend({
  total: z.number().int(),
  page: z.number().int(),
  per_page: z.number().int(),
});

export const APIEnvelopeSchema = z.object({
  data: z.record(z.unknown()),
  meta: APIMetaSchema,
});

export const PaginatedEnvelopeSchema = z.object({
  data: z.array(z.record(z.unknown())),
  meta: PaginatedMetaSchema,
});

export type APIMeta = z.infer<typeof APIMetaSchema>;
export type PaginatedMeta = z.infer<typeof PaginatedMetaSchema>;
export type APIEnvelope = z.infer<typeof APIEnvelopeSchema>;
export type PaginatedEnvelope = z.infer<typeof PaginatedEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const JobItemSchema = z.object({
  job_id: z.string(),
  status: z.string(),
  current_stage: z.string(),
  outcome_tier: z.string().optional().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const JobStatusSchema = JobItemSchema.extend({
  stage_history: z.array(z.record(z.unknown())).default([]),
});

export const JobResultSchema = z.object({
  job_id: z.string(),
  status: z.string(),
  outcome_tier: z.string().optional().nullable(),
  environment_code: z.string().optional().nullable(),
  test_results: z.record(z.unknown()).optional().nullable(),
  quality_report: z.record(z.unknown()).optional().nullable(),
  archivist_summary: z.record(z.unknown()).optional().nullable(),
});

export const JobCreateRequestSchema = z.object({
  description: z.string().min(1),
  tags: z.array(z.string()).default([]),
  difficulty_parameters: z.record(z.unknown()).default({}),
});

export const JobCreateResponseSchema = z.object({
  job_id: z.string(),
  status: z.string(),
  message: z.string(),
});

export type JobItem = z.infer<typeof JobItemSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type JobResult = z.infer<typeof JobResultSchema>;
export type JobCreateRequest = z.infer<typeof JobCreateRequestSchema>;
export type JobCreateResponse = z.infer<typeof JobCreateResponseSchema>;

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

export const EnvironmentItemSchema = z.object({
  job_id: z.string(),
  status: z.string(),
  outcome_tier: z.string().optional().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const EnvironmentDetailSchema = z.object({
  job_id: z.string(),
  status: z.string(),
  current_stage: z.string(),
  outcome_tier: z.string().optional().nullable(),
  environment_code: z.string().optional().nullable(),
  test_results: z.record(z.unknown()).optional().nullable(),
  quality_report: z.record(z.unknown()).optional().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const EnvironmentVersionSchema = z.object({
  iteration: z.number().int(),
  code: z.string(),
  timestamp: z.string(),
  trigger: z.string().optional().nullable(),
});

export const EnvironmentTestReportSchema = z.object({
  job_id: z.string(),
  status: z.string(),
  verdict: z.string(),
  total_tests: z.number().int(),
  total_passed: z.number().int(),
  total_failed: z.number().int(),
  total_errors: z.number().int(),
  exploits_detected: z.number().int(),
  adversarial_issues: z.number().int(),
  mutation_score: z.number().optional().nullable(),
});

export type EnvironmentItem = z.infer<typeof EnvironmentItemSchema>;
export type EnvironmentDetail = z.infer<typeof EnvironmentDetailSchema>;
export type EnvironmentVersion = z.infer<typeof EnvironmentVersionSchema>;
export type EnvironmentTestReport = z.infer<typeof EnvironmentTestReportSchema>;

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

export const BenchmarkItemSchema = z.object({
  benchmark_id: z.string(),
  benchmark_name: z.string(),
  message: z.string(),
});

export const BenchmarkRunRequestSchema = z.object({
  target_code: z.string().optional().nullable(),
});

export const BenchmarkRunResultSchema = z.object({
  run_id: z.string(),
  benchmark_id: z.string(),
  status: z.string(),
  passed: z.boolean(),
  scores: z.record(z.number()),
});

export const BenchmarkResultDetailSchema = z.object({
  benchmark_id: z.string(),
  run_id: z.string(),
  timestamp: z.string(),
  passed: z.boolean(),
  scores: z.record(z.number()),
  details: z.record(z.unknown()).optional().nullable(),
});

export const BenchmarkHistoryItemSchema = z.object({
  run_id: z.string(),
  benchmark_id: z.string(),
  status: z.string(),
  passed: z.boolean(),
  scores: z.record(z.number()),
  timestamp: z.string(),
});

export type BenchmarkItem = z.infer<typeof BenchmarkItemSchema>;
export type BenchmarkRunResult = z.infer<typeof BenchmarkRunResultSchema>;
export type BenchmarkResultDetail = z.infer<typeof BenchmarkResultDetailSchema>;
export type BenchmarkHistoryItem = z.infer<typeof BenchmarkHistoryItemSchema>;

// ---------------------------------------------------------------------------
// Streaming Events
// ---------------------------------------------------------------------------

export const StreamEventSchema = z.object({
  event: z.string(),
  data: z.record(z.unknown()),
});

export type StreamEvent = z.infer<typeof StreamEventSchema>;
