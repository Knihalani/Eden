/** Every arm, by id. */
import { FLOOR_ARMS } from "./floor";
import type { Arm } from "./kit";
import { migrate } from "./migrate";
import { secrets } from "./secrets";
import { spawnWriters } from "./writers";

export const ARMS: ReadonlyMap<string, Arm> = new Map(
  [...FLOOR_ARMS, secrets, spawnWriters, migrate].map((arm) => [arm.id, arm]),
);
