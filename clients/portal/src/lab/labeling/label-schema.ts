/**
 * Defensive, best-effort interpretation of `item.label_schema` — the
 * backend (`src/eden/evaluation/labeling.py`) stores this as an
 * unstructured JSON blob per item/queue, so nothing about its shape is
 * guaranteed. We support a few common conventions and fall back to a
 * freeform text field when none match — see `label-schema-form.tsx`
 * for the renderer and `annotate-view.tsx` for how `extractLabelOptions`
 * doubles as the source of truth for the `1-9` keyboard shortcuts.
 */

export type LabelOption = { value: unknown; text: string };

export type NumericRange = { min: number; max: number; step: number };

function schemaType(schema: Record<string, unknown> | null | undefined): string | undefined {
  const t = schema?.type;
  return typeof t === "string" ? t : undefined;
}

/** Options list (radio/button choices) — or `null` if the schema isn't option-shaped. */
export function extractLabelOptions(
  schema: Record<string, unknown> | null | undefined,
): LabelOption[] | null {
  if (!schema) return null;
  if (schemaType(schema) === "boolean") {
    return [
      { value: true, text: "Yes" },
      { value: false, text: "No" },
    ];
  }
  const raw = schema.options ?? schema.choices ?? schema.labels ?? schema.enum;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw.slice(0, 9).map((o) => {
    if (o && typeof o === "object" && !Array.isArray(o)) {
      const rec = o as Record<string, unknown>;
      const value = "value" in rec ? rec.value : (rec.label ?? rec.text ?? o);
      const text = String(rec.label ?? rec.text ?? rec.value ?? o);
      return { value, text };
    }
    return { value: o, text: String(o) };
  });
}

/** Numeric score/rating range — or `null` if the schema isn't numeric-shaped. */
export function extractNumericRange(
  schema: Record<string, unknown> | null | undefined,
): NumericRange | null {
  if (!schema) return null;
  const type = schemaType(schema);
  if (type !== "score" && type !== "rating" && type !== "number") return null;
  const min = typeof schema.min === "number" ? schema.min : 0;
  const max = typeof schema.max === "number" ? schema.max : 10;
  const step = typeof schema.step === "number" ? schema.step : 1;
  return { min, max, step };
}
