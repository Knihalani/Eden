// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LabToastProvider } from "@/lab/lab-toast";
import { SettingsKeysView } from "@/lab/settings/settings-keys-view";
import type { ApiKeyFixture } from "@/lab/fixtures/settings";

function key(overrides: Partial<ApiKeyFixture> = {}): ApiKeyFixture {
  return {
    id: "key_1",
    name: "Quickstart",
    prefix: "sk_live_abc",
    scopes: ["ingest"],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000000Z",
    lastUsed: null,
    createdBy: "550e8400-e29b-41d4-a716-446655440000",
    ...overrides,
  };
}

describe("SettingsKeysView P2 (R046-R048)", () => {
  it("hides raw UUID creators and offers Copy prefix", () => {
    render(
      <LabToastProvider>
        <SettingsKeysView
          keys={[
            key(),
            key({
              id: "key_2",
              prefix: "sk_live_def",
              createdAt: "2026-02-01T00:00:00Z",
            }),
          ]}
          selectedId="key_1"
          onSelect={vi.fn()}
          onCreate={vi.fn(async () => key({ id: "new" }))}
          onRevoke={vi.fn(async () => undefined)}
          onDismissSecret={vi.fn()}
        />
      </LabToastProvider>,
    );

    expect(screen.queryByText(/550e8400/)).toBeNull();
    expect(screen.getByText(/A teammate/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy prefix" })).toBeTruthy();
  });
});
