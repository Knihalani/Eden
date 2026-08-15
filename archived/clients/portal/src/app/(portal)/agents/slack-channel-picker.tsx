"use client";

import type { SlackChannel } from "@/lib/api/resources";

/** Channels the Point 2 picker may show — no DMs, no user ids (Y). */
export function pickableChannels(channels: SlackChannel[]): SlackChannel[] {
  return channels.filter((c) => {
    const id = (c.id || "").trim();
    return id && !id.startsWith("D") && !id.startsWith("U") && !id.startsWith("W");
  });
}

export function SlackWatchPicker({
  channels,
  selectedIds,
  onChange,
}: {
  channels: SlackChannel[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const list = pickableChannels(channels);
  const selected = new Set(selectedIds);
  return (
    <fieldset className="min-w-[16rem] text-sm">
      <legend className="mb-1">Watch channels — where this job is assigned or discussed</legend>
      {list.length === 0 ? (
        <p className="type-meta">No channels yet. Connect Slack, then pick where the job happens.</p>
      ) : (
        <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-[var(--line)] p-2">
          {list.map((c) => {
            const checked = selected.has(c.id);
            return (
              <li key={c.id}>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={`Watch #${c.name}`}
                    checked={checked}
                    onChange={() => {
                      const next = checked
                        ? selectedIds.filter((id) => id !== c.id)
                        : [...selectedIds, c.id];
                      onChange(next);
                    }}
                  />
                  <span>
                    #{c.name}
                    {c.is_member ? "" : " · invite Eden"}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}

export function SlackNotifyPicker({
  channels,
  value,
  onChange,
}: {
  channels: SlackChannel[];
  value: string;
  onChange: (id: string) => void;
}) {
  const list = pickableChannels(channels);
  return (
    <label className="min-w-[16rem] text-sm">
      Notify channel — leftover and change cards post here
      <select
        className="ds-input mt-1 w-full"
        aria-label="Notify Slack channel"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Choose a channel…</option>
        {list.map((c) => (
          <option key={c.id} value={c.id}>
            #{c.name}
            {c.is_member ? "" : " · invite Eden"}
          </option>
        ))}
      </select>
    </label>
  );
}
