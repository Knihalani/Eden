/**
 * Eden TypeScript SDK — Benchmarks resource.
 */

import { EdenClient } from "../client";
import {
  BenchmarkItemSchema,
  BenchmarkRunResultSchema,
  BenchmarkResultDetailSchema,
  BenchmarkHistoryItemSchema,
  type BenchmarkItem,
  type BenchmarkRunResult,
  type BenchmarkResultDetail,
  type BenchmarkHistoryItem,
} from "../models";

export class BenchmarksResource {
  constructor(private client: EdenClient) {}

  async create(params: {
    benchmarkName: string;
    targetAgents: string[];
    criteria: Record<string, unknown>;
    idempotencyKey?: string;
  }): Promise<BenchmarkItem> {
    const { idempotencyKey, ...body } = params;
    const data = await this.client.post("/benchmarks", {
      json: {
        benchmark_name: body.benchmarkName,
        target_agents: body.targetAgents,
        criteria: body.criteria,
      },
      idempotencyKey,
    });
    return BenchmarkItemSchema.parse(data);
  }

  async run(
    benchmarkId: string,
    params: { targetCode: string; idempotencyKey?: string }
  ): Promise<BenchmarkRunResult> {
    const { idempotencyKey, targetCode } = params;
    const data = await this.client.post(`/benchmarks/${benchmarkId}/run`, {
      json: { target_code: targetCode },
      idempotencyKey,
    });
    return BenchmarkRunResultSchema.parse(data);
  }

  async results(benchmarkId: string): Promise<BenchmarkResultDetail> {
    const data = await this.client.get(`/benchmarks/${benchmarkId}/results`);
    return BenchmarkResultDetailSchema.parse(data);
  }

  async history(): Promise<BenchmarkHistoryItem[]> {
    const data = await this.client.get("/benchmarks/history");
    const items = Array.isArray(data) ? data : (data.data as unknown[] ?? []);
    return items.map((h) => BenchmarkHistoryItemSchema.parse(h));
  }
}
