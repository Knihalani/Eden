import { cn } from "@/lib/utils";
import {
  extractLabelOptions,
  extractNumericRange,
  type LabelOption,
} from "@/lab/labeling/label-schema";

/**
 * Renders a form driven by `item.label_schema` (FEAT-83). Three
 * conventions are supported, checked in order — options/choices/enum
 * (or `type: "boolean"`) render as a numbered button list so the
 * `1-9` keyboard shortcuts (wired in `annotate-view.tsx`, sourced from
 * the same `extractLabelOptions`) line up visually; `type: "score" |
 * "rating" | "number"` renders a bounded numeric input; anything else
 * falls back to freeform text so no schema shape is ever a dead end.
 */
export function LabelSchemaForm({
  schema,
  value,
  onChange,
}: {
  schema: Record<string, unknown> | null | undefined;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const options = extractLabelOptions(schema);
  if (options) {
    return <OptionsForm options={options} value={value} onChange={onChange} />;
  }

  const numeric = extractNumericRange(schema);
  if (numeric) {
    const current = typeof value === "number" ? value : numeric.min;
    return (
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={numeric.min}
          max={numeric.max}
          step={numeric.step}
          value={current}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label="Label score"
          className="h-2 flex-1 cursor-pointer accent-[var(--accent)]"
        />
        <span className="type-ui w-10 text-right tabular-nums text-[var(--text)]">
          {current}
        </span>
      </div>
    );
  }

  return (
    <textarea
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Enter a label…"
      rows={3}
      aria-label="Label"
      className="ds-input w-full resize-y"
    />
  );
}

function OptionsForm({
  options,
  value,
  onChange,
}: {
  options: LabelOption[];
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Label options">
      {options.map((opt, i) => {
        const selected = Object.is(value, opt.value) || value === opt.value;
        return (
          <button
            key={i}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.value)}
            className={cn(
              "ds-btn ds-btn-sm",
              selected ? "ds-btn-primary" : "ds-btn-secondary",
            )}
          >
            <span className="type-meta mr-1.5 opacity-70">{i + 1}</span>
            {opt.text}
          </button>
        );
      })}
    </div>
  );
}
