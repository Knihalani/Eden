export type { SearchQuery, Source, SourceResolver } from "./source";
export { StaticSource, type StaticDoc } from "./static-source";
export { McpSource, ReadOnlyViolation, toItems, type McpSourceOptions } from "./mcp-source";
export { searchSources, type SourceOutcome } from "./fanout";
export { SourceFanout, type FanoutOptions, type FanoutOutcome, type FanoutStatus } from "./guarded";
export { buildShape, inert, SHAPES, type Shape, type ShapeInput, type ShapeOptions } from "./shapes";
export {
  cueCoverage,
  PlannedSource,
  QueryPlanner,
  type PlanOutcome,
  type PlannerArm,
  type PlannerOptions,
  type PlannerStore,
} from "./planner";
