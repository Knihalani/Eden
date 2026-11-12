/**
 * onnxruntime-node 1.20.1 names `dist/index.d.ts` as its types but does not ship it: the surface `encoder.ts` uses,
 * declared here (narrowed to what is called).
 */
declare module "onnxruntime-node" {
  export class Tensor {
    constructor(type: "int64", data: BigInt64Array, dims: number[]);
    readonly data: unknown;
    readonly dims: readonly number[];
  }
  export interface SessionOptions {
    intraOpNumThreads?: number;
    interOpNumThreads?: number;
    graphOptimizationLevel?: "disabled" | "basic" | "extended" | "all";
    enableCpuMemArena?: boolean;
    enableMemPattern?: boolean;
  }
  export class InferenceSession {
    static create(path: string, options?: SessionOptions): Promise<InferenceSession>;
    readonly inputNames: readonly string[];
    readonly outputNames: readonly string[];
    run(feeds: Record<string, unknown>): Promise<Record<string, Tensor>>;
  }
}
