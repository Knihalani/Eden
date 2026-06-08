/**
 * Eden TypeScript SDK — Environments resource.
 */

import { EdenClient } from "../client";
import {
  EnvironmentItemSchema,
  EnvironmentDetailSchema,
  EnvironmentVersionSchema,
  EnvironmentTestReportSchema,
  type EnvironmentItem,
  type EnvironmentDetail,
  type EnvironmentVersion,
  type EnvironmentTestReport,
} from "../models";

export class EnvironmentsResource {
  constructor(private client: EdenClient) {}

  async list(options: {
    status?: string;
    outcomeTier?: string;
    q?: string;
    sort?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ environments: EnvironmentItem[]; total: number; limit: number; offset: number }> {
    const params: Record<string, string | number | undefined> = {
      sort: options.sort ?? "created_at:desc",
      limit: options.limit ?? 20,
      offset: options.offset ?? 0,
    };
    if (options.status) params.status = options.status;
    if (options.outcomeTier) params.outcome_tier = options.outcomeTier;
    if (options.q) params.q = options.q;

    const data = await this.client.get("/environments", { params });
    const items = Array.isArray(data) ? data : (data.environments as unknown[] ?? []);
    return {
      environments: items.map((i) => EnvironmentItemSchema.parse(i)),
      total: (data.total as number) ?? items.length,
      limit: (data.limit as number) ?? 20,
      offset: (data.offset as number) ?? 0,
    };
  }

  async get(jobId: string): Promise<EnvironmentDetail> {
    const data = await this.client.get(`/environments/${jobId}`);
    return EnvironmentDetailSchema.parse(data);
  }

  async download(jobId: string): Promise<Uint8Array> {
    const result = await this.client.request("GET", `/environments/${jobId}/download`);
    if (result._binary && result.content instanceof Uint8Array) {
      return result.content;
    }
    throw new Error("Expected binary ZIP response, got JSON");
  }

  async tests(jobId: string): Promise<EnvironmentTestReport> {
    const data = await this.client.get(`/environments/${jobId}/tests`);
    return EnvironmentTestReportSchema.parse(data);
  }

  async versions(jobId: string): Promise<EnvironmentVersion[]> {
    const data = await this.client.get(`/environments/${jobId}/versions`);
    const items = Array.isArray(data) ? data : (data.data as unknown[] ?? []);
    return items.map((v) => EnvironmentVersionSchema.parse(v));
  }
}
