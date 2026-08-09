/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LabToastProvider } from "@/lab/lab-toast";
import { AccountDangerZoneCard } from "@/lab/settings/account-danger-zone-card";
import type { AccountDeleteResponse } from "@/lib/api/resources";

const { deleteAccountMock, signOutMock } = vi.hoisted(() => ({
  deleteAccountMock: vi.fn(),
  signOutMock: vi.fn(),
}));

vi.mock("@/lib/api/resources", () => ({
  api: { deleteAccount: deleteAccountMock },
}));

vi.mock("@clerk/nextjs", () => ({
  useClerk: () => ({ signOut: signOutMock }),
}));

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

const sampleErasureResult: AccountDeleteResponse = {
  account_anonymized: true,
  incomplete_orgs: ["org-a"],
  store_statuses: [
    { store: "postgres", status: "ok", detail: "12 rows anonymised across 6 tables" },
    { store: "qdrant", status: "failed", detail: "no per-user index" },
    { store: "typesense", status: "unsupported", detail: "collection lacks user_id field" },
  ],
};

function renderCard() {
  render(
    <LabToastProvider>
      <AccountDangerZoneCard />
    </LabToastProvider>,
  );
}

beforeEach(() => {
  deleteAccountMock.mockReset();
  signOutMock.mockReset();
  vi.useRealTimers();
});

describe("AccountDangerZoneCard", () => {
  it("hides the confirm input until 'Delete my account' is clicked", () => {
    renderCard();
    expect(
      screen.queryByLabelText("Type DELETE to confirm account deletion"),
    ).not.toBeInTheDocument();
  });

  it("keeps the destructive confirm button disabled until the exact phrase is typed", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole("button", { name: "Delete my account" }));
    const confirmButton = screen.getByRole("button", {
      name: "Permanently delete my account",
    });
    expect(confirmButton).toBeDisabled();

    const input = screen.getByLabelText(
      "Type DELETE to confirm account deletion",
    );
    await user.type(input, "delete");
    expect(confirmButton).toBeDisabled();

    await user.clear(input);
    await user.type(input, "DELETE");
    expect(confirmButton).toBeEnabled();
  });

  it("shows per-store erasure statuses after deletion succeeds", async () => {
    const user = userEvent.setup();
    deleteAccountMock.mockResolvedValue(sampleErasureResult);
    renderCard();

    await user.click(screen.getByRole("button", { name: "Delete my account" }));
    await user.type(
      screen.getByLabelText("Type DELETE to confirm account deletion"),
      "DELETE",
    );
    await user.click(
      screen.getByRole("button", { name: "Permanently delete my account" }),
    );

    await waitFor(() => expect(deleteAccountMock).toHaveBeenCalledWith("DELETE"));

    expect(
      screen.getByRole("list", { name: "Per-store erasure status" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Postgres:")).toBeInTheDocument();
    expect(screen.getByText("erased")).toBeInTheDocument();
    expect(screen.getByText("Qdrant:")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText("Typesense:")).toBeInTheDocument();
    expect(screen.getByText("not yet supported")).toBeInTheDocument();
    expect(screen.getByText(/no per-user index/)).toBeInTheDocument();
  });

  it("schedules sign-out after erasure succeeds", async () => {
    const user = userEvent.setup();
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    deleteAccountMock.mockResolvedValue(sampleErasureResult);
    renderCard();

    await user.click(screen.getByRole("button", { name: "Delete my account" }));
    await user.type(
      screen.getByLabelText("Type DELETE to confirm account deletion"),
      "DELETE",
    );
    await user.click(
      screen.getByRole("button", { name: "Permanently delete my account" }),
    );

    await waitFor(() => expect(deleteAccountMock).toHaveBeenCalledWith("DELETE"));
    await waitFor(() => expect(timeoutSpy).toHaveBeenCalled());
    expect(timeoutSpy.mock.calls.some((call) => call[1] === 4000)).toBe(true);
    timeoutSpy.mockRestore();
  });

  it("does not sign out and re-enables the form when deletion fails", async () => {
    const user = userEvent.setup();
    const gate = deferred<void>();
    deleteAccountMock.mockImplementation(() => gate.promise);
    renderCard();

    await user.click(screen.getByRole("button", { name: "Delete my account" }));
    await user.type(
      screen.getByLabelText("Type DELETE to confirm account deletion"),
      "DELETE",
    );
    await user.click(
      screen.getByRole("button", { name: "Permanently delete my account" }),
    );

    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();

    gate.reject(new Error("org erasure failed"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Permanently delete my account" }),
      ).toBeEnabled(),
    );
    expect(signOutMock).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("list", { name: "Per-store erasure status" }),
    ).not.toBeInTheDocument();
  });

  it("cancel clears the confirm state", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole("button", { name: "Delete my account" }));
    await user.type(
      screen.getByLabelText("Type DELETE to confirm account deletion"),
      "DELETE",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      screen.getByRole("button", { name: "Delete my account" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Type DELETE to confirm account deletion"),
    ).not.toBeInTheDocument();
  });
});
