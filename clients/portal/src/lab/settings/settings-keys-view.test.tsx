import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LabToastProvider } from "@/lab/lab-toast";
import { SettingsKeysView } from "@/lab/settings/settings-keys-view";
import type { ApiKeyFixture } from "@/lab/fixtures/settings";

function makeKey(overrides: Partial<ApiKeyFixture> = {}): ApiKeyFixture {
  return {
    id: "key_1",
    name: "Staging ingest",
    prefix: "sk_live_abc",
    scopes: ["ingest"],
    status: "active",
    createdAt: "2026-01-01",
    lastUsed: null,
    createdBy: "You",
    ...overrides,
  };
}

/** Deferred promise so tests can control exactly when an async call resolves. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderView(
  props: Partial<React.ComponentProps<typeof SettingsKeysView>> = {},
) {
  const keys = props.keys ?? [makeKey()];
  const onCreate =
    props.onCreate ?? vi.fn(async () => makeKey({ id: "new_key" }));
  const onRevoke = props.onRevoke ?? vi.fn(async () => undefined);
  const onSelect = props.onSelect ?? vi.fn();
  const onDismissSecret = props.onDismissSecret ?? vi.fn();

  render(
    <LabToastProvider>
      <SettingsKeysView
        keys={keys}
        selectedId={props.selectedId ?? keys[0]?.id ?? null}
        onSelect={onSelect}
        onCreate={onCreate}
        onRevoke={onRevoke}
        onDismissSecret={onDismissSecret}
      />
    </LabToastProvider>,
  );

  return { onCreate, onRevoke, onSelect, onDismissSecret };
}

describe("SettingsKeysView — create key race guard", () => {
  it("fires onCreate only once when the Create button is double-clicked while pending", async () => {
    const user = userEvent.setup();
    const gate = deferred<ApiKeyFixture>();
    const onCreate = vi.fn(() => gate.promise);
    renderView({ onCreate });

    await user.type(screen.getByLabelText("API key name"), "Prod ingest");

    const createButton = screen.getByRole("button", { name: "Create" });
    // Fire two rapid clicks before the in-flight promise settles.
    await user.click(createButton);
    await user.click(createButton);
    await user.click(createButton);

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Creating…" }),
    ).toBeDisabled();

    gate.resolve(makeKey({ id: "new_key" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument(),
    );
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("re-enables the Create button after the create call settles, allowing another create", async () => {
    const user = userEvent.setup();
    const onCreate = vi
      .fn()
      .mockResolvedValueOnce(makeKey({ id: "new_key_1" }))
      .mockResolvedValueOnce(makeKey({ id: "new_key_2" }));
    renderView({ onCreate });

    await user.type(screen.getByLabelText("API key name"), "First key");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));

    await user.type(screen.getByLabelText("API key name"), "Second key");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(onCreate).toHaveBeenCalledTimes(2);
  });
});

describe("SettingsKeysView — revoke key race guard", () => {
  it("fires onRevoke only once when Confirm revoke is double-clicked while pending", async () => {
    const user = userEvent.setup();
    const gate = deferred<void>();
    const onRevoke = vi.fn(() => gate.promise);
    renderView({ onRevoke });

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    const confirmButton = screen.getByRole("button", { name: "Confirm revoke" });

    await user.click(confirmButton);
    // Immediately after confirming, the view reverts to the plain
    // "Revoke" (or "Revoking…") control while the call is in flight —
    // simulate a user re-triggering Revoke -> Confirm revoke rapidly.
    const pendingRevokeButton = screen.getByRole("button", {
      name: /Revok(e|ing…)/,
    });
    await user.click(pendingRevokeButton);
    if (screen.queryByRole("button", { name: "Confirm revoke" })) {
      await user.click(screen.getByRole("button", { name: "Confirm revoke" }));
    }

    expect(onRevoke).toHaveBeenCalledTimes(1);

    gate.resolve();
    await waitFor(() => expect(onRevoke).toHaveBeenCalledTimes(1));
  });

  it("disables Revoke/Confirm controls for the key while a revoke is pending, then re-enables", async () => {
    const user = userEvent.setup();
    const gate = deferred<void>();
    const onRevoke = vi.fn(() => gate.promise);
    renderView({ onRevoke });

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));

    expect(screen.getByRole("button", { name: "Revoking…" })).toBeDisabled();
    expect(onRevoke).toHaveBeenCalledTimes(1);

    gate.resolve();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Revoke" })).toBeEnabled(),
    );

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));
    expect(onRevoke).toHaveBeenCalledTimes(2);
  });
});
