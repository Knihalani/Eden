/**
 * F2's screened instructions: the engine's `CHECK_SYSTEMS` (`pushCheckRecall` 1 and 2), by the screen's arm names.
 * A: the act rule names "already done" and "covers its day" as reasons to stop. R: A, plus person facts, short group
 * notices and a lean to yes when unsure. A new arm to screen is added here before it becomes a form.
 */
import { CHECK_SYSTEMS } from "@eden/engine";

export const ARM_SYSTEMS: Record<string, string> = { A: CHECK_SYSTEMS[1]!, R: CHECK_SYSTEMS[2]! };
