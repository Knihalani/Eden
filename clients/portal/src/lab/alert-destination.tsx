"use client";

import { cn } from "@/lib/utils";

export type AlertChannel = "slack" | "email" | "webhook";

const CHANNELS: {
  id: AlertChannel;
  label: string;
  hint: string;
  placeholder: string;
}[] = [
  {
    id: "slack",
    label: "Slack",
    hint: "Channel or user",
    placeholder: "#alerts",
  },
  {
    id: "email",
    label: "Email",
    hint: "Inbox or list",
    placeholder: "oncall@company.com",
  },
  {
    id: "webhook",
    label: "Webhook",
    hint: "URL or pager",
    placeholder: "https://hooks.example.com/…",
  },
];

export function defaultDestinationFor(channel: AlertChannel): string {
  if (channel === "slack") return "";
  if (channel === "email") return "";
  return "";
}

export function channelMeta(channel: AlertChannel) {
  return CHANNELS.find((c) => c.id === channel) ?? CHANNELS[0];
}

/** Pick Slack / Email / Webhook + where it lands. */
export function AlertDestinationEditor({
  channel,
  destination,
  onChange,
  disabled = false,
  idPrefix = "dest",
}: {
  channel: AlertChannel;
  destination: string;
  onChange: (next: { channel: AlertChannel; destination: string }) => void;
  disabled?: boolean;
  idPrefix?: string;
  /** @deprecated no longer changes layout */
  compact?: boolean;
}) {
  const meta = channelMeta(channel);

  return (
    <div
      className={cn("space-y-3", disabled && "pointer-events-none opacity-50")}
      aria-disabled={disabled}
    >
      <div>
        <p className="type-label mb-2" id={`${idPrefix}-channel`}>
          Send to
        </p>
        <div
          className="flex flex-wrap gap-1.5"
          role="radiogroup"
          aria-labelledby={`${idPrefix}-channel`}
        >
          {CHANNELS.map((c) => {
            const active = channel === c.id;
            return (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                className={cn(
                  "ds-btn ds-btn-sm",
                  active ? "ds-btn-primary" : "ds-btn-ghost",
                )}
                onClick={() => {
                  if (c.id === channel) return;
                  onChange({
                    channel: c.id,
                    destination: defaultDestinationFor(c.id),
                  });
                }}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      <label className="block space-y-1.5">
        <span className="type-label">{meta.hint}</span>
        <input
          id={`${idPrefix}-destination`}
          type="text"
          className="ds-input w-full"
          value={destination}
          disabled={disabled}
          placeholder={meta.placeholder}
          onChange={(e) =>
            onChange({ channel, destination: e.target.value })
          }
          autoComplete="off"
          spellCheck={false}
        />
      </label>
    </div>
  );
}

export function formatDestination(channel: AlertChannel, destination: string) {
  const label = channelMeta(channel).label;
  return `${label} · ${destination}`;
}
