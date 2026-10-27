export type { SearchQuery, Source, SourceResolver } from "./source";
export { StaticSource, type StaticDoc } from "./static-source";
export { McpSource, ReadOnlyViolation, toItems, type McpSourceOptions } from "./mcp-source";
export { searchSources, type SourceOutcome } from "./fanout";
