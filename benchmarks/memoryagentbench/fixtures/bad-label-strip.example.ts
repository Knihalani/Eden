/** example / bad-label-strip — a later runner that deletes `label:` from stored shots. */

export const badLabelStrip = {
  exam: "Table 3",
  k: 10,
  eventqa: 534000,
  fc: 262000,
  sh: 197000,
  mh: 421000,
  labelStrip: true,
};

/** Ingest that strips ICL labels from haystack shots before observe / JSONL / store. */
export function stripLabelsBeforeStore(shot: string): string {
  return shot.replace(/label:\s*\d+/gi, "");
}
