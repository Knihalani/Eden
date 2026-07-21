"use client";

import { useEffect, useState, useRef } from "react";
import { metricStudioApi } from "@/lib/api";
import { Wand2, Plus, Trash2, Sparkles, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  featureGatedMessage,
} from "@/lib/feature-flag-error";
import {
  blankExamples,
  studioExamplesIsDirty,
  type ExampleRow,
  type TemplateSeed,
} from "./studio-helpers";

export function FromExamplesTab({
  orgId,
  onError,
  onDirtyChange,
  templateSeed,
  onTemplateSeedConsumed,
}: {
  orgId: string;
  onError: (s: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  templateSeed: TemplateSeed | null;
  onTemplateSeedConsumed: () => void;
}) {
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("general");
  const [examples, setExamples] = useState<ExampleRow[]>(blankExamples);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generated, setGenerated] = useState<{
    rubric_id: string;
    rubric_prompt: string;
    rubric_tokens: number;
    domain: string;
  } | null>(null);
  const seedApplied = useRef<string | null>(null);

  const dirty = studioExamplesIsDirty({
    generated: !!generated,
    name,
    examples,
  });

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (!templateSeed) return;
    const key = `${templateSeed.name}:${templateSeed.domain}`;
    if (seedApplied.current === key) return;
    seedApplied.current = key;
    setName(templateSeed.name);
    setDomain(templateSeed.domain || "general");
    if (templateSeed.notes) {
      setExamples((prev) =>
        prev.map((row, idx) =>
          idx === 0
            ? { ...row, rationale: templateSeed.notes || row.rationale }
            : row,
        ),
      );
    }
    onTemplateSeedConsumed();
  }, [templateSeed, onTemplateSeedConsumed]);

  function updateExample(i: number, key: keyof ExampleRow, value: string) {
    setExamples((prev) =>
      prev.map((row, idx) => (idx === i ? { ...row, [key]: value } : row)),
    );
  }
  function addExample() {
    if (examples.length >= 5) return;
    setExamples((prev) => [...prev, { input: "", output: "", label: "pass", rationale: "" }]);
  }
  function removeExample(i: number) {
    if (examples.length <= 2) return;
    setExamples((prev) => prev.filter((_, idx) => idx !== i));
  }
  function discardGenerated() {
    if (generated) {
      const ok = window.confirm("Discard the generated rubric? This cannot be undone.");
      if (!ok) return;
    }
    setGenerated(null);
  }
  async function handleGenerate() {
    onError("");
    const filled = examples.filter((e) => e.input.trim() && e.output.trim());
    if (filled.length < 2) {
      onError("Provide at least 2 examples with input and output filled in.");
      return;
    }
    if (!name.trim()) {
      onError("Name is required.");
      return;
    }
    setGenerating(true);
    try {
      const data = await metricStudioApi.fromExamples(orgId, {
        name: name.trim(),
        domain: domain.trim() || "general",
        examples: filled.map((e) => ({
          input: e.input.trim(),
          output: e.output.trim(),
          label: e.label,
          rationale: e.rationale.trim() || undefined,
        })),
      });
      setGenerated({
        rubric_id: data.rubric_id,
        rubric_prompt: data.rubric_prompt,
        rubric_tokens: data.rubric_tokens,
        domain: data.domain,
      });
    } catch (err) {
      onError(featureGatedMessage(err, "Generation failed"));
    } finally {
      setGenerating(false);
    }
  }
  async function handleSave() {
    if (!generated) return;
    onError("");
    setSaving(true);
    try {
      await metricStudioApi.createMetric(orgId, {
        name: name.trim(),
        rubric_id: generated.rubric_id,
        domain: generated.domain,
      });
      setGenerated(null);
      setName("");
      setDomain("general");
      setExamples(blankExamples());
      seedApplied.current = null;
    } catch (err) {
      onError(featureGatedMessage(err, "Save failed"));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="space-y-space-3" data-wave-e5-studio="examples">
      <div className="space-y-space-3 border-y border-[var(--border-subtle)] py-space-3">
        <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
          <Wand2 className="h-4 w-4 text-[var(--accent)]" aria-hidden />
          Examples
          {dirty ? (
            <span className="text-xs font-normal text-[var(--warning)]">Unsaved</span>
          ) : null}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-space-3">
          <div>
            <label htmlFor="metric-name" className="text-xs font-medium text-[var(--text-muted)] mb-space-1 block">
              Metric name
            </label>
            <input
              id="metric-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Tone consistency"
              aria-label="Metric name"
              disabled={generating || saving}
              className="w-full h-8 max-md:min-h-11 px-3 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] disabled:opacity-50"
            />
          </div>
          <div>
            <label htmlFor="metric-domain" className="text-xs font-medium text-[var(--text-muted)] mb-space-1 block">
              Domain
            </label>
            <select
              id="metric-domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              aria-label="Metric domain"
              disabled={generating || saving}
              className="w-full h-8 max-md:min-h-11 px-3 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] disabled:opacity-50"
            >
              {["general", "safety", "compliance", "marketing", "legal", "factual", "tone"].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-space-2">
          {examples.map((ex, i) => (
            <div key={i} className="border-y border-[var(--border-subtle)] py-space-2 space-y-space-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--text-muted)]">Example {i + 1}</span>
                {examples.length > 2 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 max-md:min-h-11 max-md:min-w-11 text-[var(--text-muted)] hover:text-[var(--error)]"
                    onClick={() => removeExample(i)}
                    aria-label={`Remove example ${i + 1}`}
                    disabled={generating || saving}
                    title="Remove example"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  </Button>
                )}
              </div>
              <input
                type="text"
                value={ex.input}
                onChange={(e) => updateExample(i, "input", e.target.value)}
                placeholder="Input"
                aria-label={`Example ${i + 1} input`}
                disabled={generating || saving}
                className="w-full h-8 max-md:min-h-11 px-3 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] disabled:opacity-50"
              />
              <input
                type="text"
                value={ex.output}
                onChange={(e) => updateExample(i, "output", e.target.value)}
                placeholder="Output"
                aria-label={`Example ${i + 1} output`}
                disabled={generating || saving}
                className="w-full h-8 max-md:min-h-11 px-3 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] disabled:opacity-50"
              />
              <div className="grid grid-cols-2 gap-space-3">
                <div>
                  <label htmlFor={`label-${i}`} className="text-xs font-medium text-[var(--text-muted)] mb-space-1 block">
                    Label
                  </label>
                  <select
                    id={`label-${i}`}
                    value={ex.label}
                    onChange={(e) => updateExample(i, "label", e.target.value as "pass" | "fail")}
                    aria-label={`Example ${i + 1} label`}
                    disabled={generating || saving}
                    className="w-full h-8 max-md:min-h-11 px-3 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] disabled:opacity-50"
                  >
                    <option value="pass">pass</option>
                    <option value="fail">fail</option>
                  </select>
                </div>
                <div>
                  <label htmlFor={`rationale-${i}`} className="text-xs font-medium text-[var(--text-muted)] mb-space-1 block">
                    Rationale
                  </label>
                  <input
                    id={`rationale-${i}`}
                    type="text"
                    value={ex.rationale}
                    onChange={(e) => updateExample(i, "rationale", e.target.value)}
                    placeholder="Why this label?"
                    aria-label={`Example ${i + 1} rationale`}
                    disabled={generating || saving}
                    className="w-full h-8 max-md:min-h-11 px-3 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] disabled:opacity-50"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-space-2">
          {examples.length < 5 && (
            <Button
              type="button"
              variant="outline"
              className="h-8 max-md:min-h-11"
              onClick={addExample}
              aria-label="Add another example"
              disabled={generating || saving}
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              Add example
            </Button>
          )}
          <Button
            variant="default"
            className="ml-auto h-8 max-md:min-h-11"
            onClick={handleGenerate}
            loading={generating}
            aria-label="Generate rubric from examples"
          >
            <Wand2 className="w-4 h-4" aria-hidden="true" />
            Generate
          </Button>
        </div>
      </div>

      {generated && (
        <div className="border-y border-[var(--border-subtle)] py-space-3 space-y-space-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-[var(--accent)]" aria-hidden />
              Generated rubric
            </h3>
            <span className="text-xs text-[var(--text-muted)]">
              ~{generated.rubric_tokens} tokens
            </span>
          </div>
          <pre className="text-xs bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto max-h-[40vh] whitespace-pre-wrap">
            {generated.rubric_prompt}
          </pre>
          <div className="flex justify-end gap-space-2">
            <Button
              type="button"
              variant="ghost"
              className="h-8 max-md:min-h-11"
              onClick={discardGenerated}
              disabled={saving}
              aria-label="Discard generated rubric"
            >
              Discard
            </Button>
            <Button
              variant="outline"
              className="h-8 max-md:min-h-11"
              onClick={handleSave}
              loading={saving}
              aria-label="Save generated rubric as a metric"
            >
              <Save className="w-3.5 h-3.5" aria-hidden="true" />
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
