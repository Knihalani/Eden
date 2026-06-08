/**
 * Eden TypeScript SDK — Jobs resource.
 */

import { EdenClient, type RequestOptions } from "../client";
import {
  JobCreateRequestSchema,
  JobItemSchema,
  JobStatusSchema,
  JobResultSchema,
  StreamEventSchema,
  type JobItem,
  type JobStatus,
  type JobResult,
  type JobCreateRequest,
  type StreamEvent,
} from "../models";
import { SSEStream } from "../streaming";

export class JobsResource {
  constructor(private client: EdenClient) {}

  async create(params: JobCreateRequest & { idempotencyKey?: string }): Promise<JobItem> {
    const { idempotencyKey, ...body } = params;
    const data = await this.client.post("/jobs", {
      json: body,
      idempotencyKey,
    });
    return JobItemSchema.parse(data);
  }

  async list(options: {
    status?: string;
    outcomeTier?: string;
    q?: string;
    sort?: string;
    createdAfter?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ jobs: JobItem[]; total: number; limit: number; offset: number }> {
    const params: Record<string, string | number | undefined> = {
      sort: options.sort ?? "created_at:desc",
      limit: options.limit ?? 20,
      offset: options.offset ?? 0,
    };
    if (options.status) params.status = options.status;
    if (options.outcomeTier) params.outcome_tier = options.outcomeTier;
    if (options.q) params.q = options.q;
    if (options.createdAfter) params.created_after = options.createdAfter;

    const data = await this.client.get("/jobs", { params });
    const items = Array.isArray(data) ? data : (data.jobs as unknown[] ?? []);
    return {
      jobs: items.map((i) => JobItemSchema.parse(i)),
      total: (data.total as number) ?? items.length,
      limit: (data.limit as number) ?? 20,
      offset: (data.offset as number) ?? 0,
    };
  }

  async get(jobId: string): Promise<JobStatus> {
    const data = await this.client.get(`/jobs/${jobId}`);
    return JobStatusSchema.parse(data);
  }

  async getResult(jobId: string): Promise<JobResult> {
    const data = await this.client.get(`/jobs/${jobId}/result`);
    return JobResultSchema.parse(data);
  }

  async cancel(jobId: string): Promise<Record<string, unknown>> {
    return this.client.post(`/jobs/${jobId}/cancel`);
  }

  async stream(jobId: string): Promise<AsyncIterable<StreamEvent>> {
    const url = `${this.client.config.baseUrl}/v1/jobs/${jobId}/stream`;
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      ...this.client.config.getHeaders(),
    };

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`SSE request failed: ${response.status}`);
    }
    if (!response.body) {
      throw new Error("Response body is empty");
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const stream = new SSEStream(reader);
    return stream[Symbol.asyncIterator]();
  }
}
