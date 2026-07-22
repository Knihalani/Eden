"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { CHANNELS_SETTINGS_HREF } from "./alert-links";
import type { RuleRow } from "./alert-types";

const TEMPLATES = [
  {
    id: "error_rate",
    nameKey: "templates.errorRate.name" as const,
    nlKey: "templates.errorRate.nl" as const,
  },
  {
    id: "latency",
    nameKey: "templates.latency.name" as const,
    nlKey: "templates.latency.nl" as const,
  },
  {
    id: "cost",
    nameKey: "templates.cost.name" as const,
    nlKey: "templates.cost.nl" as const,
  },
] as const;

export type RuleFormValues = {
  name: string;
  nlText: string;
  compiledEql: string;
};

type Props = {
  selected?: RuleRow | null;
  canWrite: boolean;
  onCreate: (values: RuleFormValues) => Promise<void>;
  creating?: boolean;
  createError?: string | null;
  fieldErrors?: Partial<Record<keyof RuleFormValues, string>>;
};

export function RuleForm({
  selected,
  canWrite,
  onCreate,
  creating,
  createError,
  fieldErrors,
}: Props) {
  const t = useTranslations("alerts.rules");
  const [name, setName] = useState("");
  const [nlText, setNlText] = useState("");
  const [compiledEql, setCompiledEql] = useState("");
  const [showForm, setShowForm] = useState(false);

  function applyTemplate(id: (typeof TEMPLATES)[number]["id"]) {
    const tpl = TEMPLATES.find((x) => x.id === id);
    if (!tpl) return;
    setName(t(tpl.nameKey));
    setNlText(t(tpl.nlKey));
    setCompiledEql("");
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await onCreate({ name, nlText, compiledEql });
    setName("");
    setNlText("");
    setCompiledEql("");
    setShowForm(false);
  }

  return (
    <div className="space-y-4" data-testid="alert-rule-form">
      {selected ? (
        <Panel tone="flat" padding="md" data-testid="rule-detail-readonly">
          <h3 className="m-0 text-sm font-semibold text-[var(--text-primary)]">
            {selected.name}
          </h3>
          <dl className="mt-2 grid gap-2 text-sm">
            <div>
              <dt className="text-[var(--text-muted)]">{t("type")}</dt>
              <dd className="m-0 capitalize text-[var(--text-secondary)]">
                {selected.type}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--text-muted)]">{t("condition")}</dt>
              <dd className="m-0 text-[var(--text-secondary)]">
                {selected.condition || selected.description || "—"}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--text-muted)]">{t("severity")}</dt>
              <dd className="m-0 capitalize text-[var(--text-secondary)]">
                {selected.severity}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--text-muted)]">{t("channels")}</dt>
              <dd className="m-0 text-[var(--text-secondary)]">
                {selected.channelRefs.length
                  ? selected.channelRefs.join(", ")
                  : t("noChannels")}
              </dd>
            </div>
          </dl>
          <p className="mt-3 m-0 text-xs text-[var(--text-muted)]">
            {t("readonlyHint")}
          </p>
          <Link
            href={CHANNELS_SETTINGS_HREF}
            className="mt-2 inline-block text-sm text-[var(--text-secondary)] hover:underline"
            data-testid="rules-channels-link"
          >
            {t("configureChannels")}
          </Link>
        </Panel>
      ) : null}

      {canWrite ? (
        <div className="space-y-3">
          {!showForm ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                className="min-h-11"
                onClick={() => setShowForm(true)}
                data-testid="rule-create-open"
              >
                {t("createCta")}
              </Button>
              {TEMPLATES.map((tpl) => (
                <Button
                  key={tpl.id}
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="min-h-11"
                  onClick={() => applyTemplate(tpl.id)}
                >
                  {t(tpl.nameKey)}
                </Button>
              ))}
            </div>
          ) : (
            <form
              onSubmit={(e) => void handleSubmit(e)}
              className="space-y-3"
              data-testid="rule-create-form"
            >
              <div>
                <label
                  htmlFor="rule-name"
                  className="mb-1 block text-xs text-[var(--text-muted)]"
                >
                  {t("name")}
                </label>
                <Input
                  id="rule-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-11"
                  required
                  aria-invalid={Boolean(fieldErrors?.name)}
                />
                {fieldErrors?.name ? (
                  <p className="mt-1 m-0 text-xs text-[var(--error)]">
                    {fieldErrors.name}
                  </p>
                ) : null}
              </div>
              <div>
                <label
                  htmlFor="rule-nl"
                  className="mb-1 block text-xs text-[var(--text-muted)]"
                >
                  {t("condition")}
                </label>
                <textarea
                  id="rule-nl"
                  value={nlText}
                  onChange={(e) => setNlText(e.target.value)}
                  className="min-h-[5rem] w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)]"
                  required
                  aria-invalid={Boolean(fieldErrors?.nlText)}
                />
                {fieldErrors?.nlText ? (
                  <p className="mt-1 m-0 text-xs text-[var(--error)]">
                    {fieldErrors.nlText}
                  </p>
                ) : null}
              </div>
              <div>
                <label
                  htmlFor="rule-eql"
                  className="mb-1 block text-xs text-[var(--text-muted)]"
                >
                  {t("eqlOptional")}
                </label>
                <Input
                  id="rule-eql"
                  value={compiledEql}
                  onChange={(e) => setCompiledEql(e.target.value)}
                  className="h-11 font-mono"
                  placeholder={t("eqlPlaceholder")}
                />
              </div>
              {createError ? (
                <p className="m-0 text-sm text-[var(--error)]" role="alert">
                  {createError}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  size="sm"
                  className="min-h-11"
                  disabled={creating}
                  data-testid="rule-save"
                >
                  {creating ? t("saving") : t("save")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="min-h-11"
                  onClick={() => setShowForm(false)}
                >
                  {t("cancel")}
                </Button>
              </div>
            </form>
          )}
        </div>
      ) : (
        <p className="m-0 text-sm text-[var(--text-muted)]">{t("viewerHint")}</p>
      )}
    </div>
  );
}
