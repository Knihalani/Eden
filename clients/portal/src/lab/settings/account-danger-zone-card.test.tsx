import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LabToastProvider } from "@/lab/lab-toast";
import { AccountDangerZoneCard } from "@/lab/settings/account-danger-zone-card";

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

  it("calls api.deleteAccount then signs out on success", async () => {
    const user = userEvent.setup();
    deleteAccountMock.mockResolvedValue(undefined);
    signOutMock.mockResolvedValue(undefined);
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
    await waitFor(() =>
      expect(signOutMock).toHaveBeenCalledWith({ redirectUrl: "/" }),
    );
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
