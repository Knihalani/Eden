/** Every arm, by id. */
import { BENCH_ARMS } from "./bench";
import { DELIVERY_ARMS } from "./delivery";
import { extraction } from "./extraction";
import { FACT_ARMS } from "./facts";
import { FLOOR_ARMS } from "./floor";
import type { Arm } from "./kit";
import { migrate } from "./migrate";
import { PLACE_ARMS } from "./place";
import { POLICY_ARMS } from "./policy";
import { secrets } from "./secrets";
import { spawnWriters } from "./writers";

export const ARMS: ReadonlyMap<string, Arm> = new Map(
  [
    ...FLOOR_ARMS,
    secrets,
    spawnWriters,
    migrate,
    ...PLACE_ARMS,
    ...DELIVERY_ARMS,
    ...POLICY_ARMS,
    ...FACT_ARMS,
    extraction,
    ...BENCH_ARMS,
  ].map((arm) => [arm.id, arm]),
);
