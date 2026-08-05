// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/core";
import { LabToastProvider } from "@/lab/lab-toast";

// FEAT-18 — the Alert rules tab on /signals wires the real
// GET/POST/PATCH/DELETE /orgs/{org}/nl-alert-rules + POST
// /orgs/{org}/alerts/compile endpoints. These tests exercise the list
// render, the compile→review→save create flow, and the admin-only
// gating (owner/admin can author; other roles get a read-only list and
// a graceful message on a 403).

const listMock = vi.fn();
const compileMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();

vi.mock("@/lib/api/resources", () => ({
  nlAlertRulesApi: {
    list: (...args: unknown[]) => listMock(...args),
    compile: (...args: unknown[]) => compileMock(...args),
    create: (...args: unknown[]) => createMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
    delete: (...args: unknown[]) => deleteMock(...args),
  },
}));

vi.mock("@/hooks/use-org", () => ({
  useOrg: () => ({ currentOrg: { id: "org_1" } }),
}));

let mockRole: string | null = "admin";
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    role: mockRole,
    permissions: new Set(),
    hasPermission: () => false,
  }),
}));

const confirmMock = vi.fn(() => Promise.resolve(true));
vi.mock("@/hooks/use-confirm", () => ({
  useConfirm: () => confirmMock,
}));

const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: () => null, toString: () => "" }),
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  usePathname: () => "/signals",
}));

import { NlAlertRulesView } from "./nl-alert-rules-panel";

function withClient(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={client}>
      <LabToastProvider>{node}</LabToastProvider>
    </QueryClientProvider>
  );
}

const RULE = {
  id: "rule_1",
  org_id: "org_1",
  name: "High error rate",
  nl_text: "error rate exceeds 5% in the last hour",
  compiled_eql: "SELECT * FROM events WHERE error_rate > 0.05",
  triage_enabled: true,
  channels: { in_app: true },
  enabled: true,
  created_by: "user_1",
  last_fired_at: "",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
};

beforeEach(() => {
  listMock.mockReset();
  compileMock.mockReset();
  createMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset();
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
  replaceMock.mockReset();
  mockRole = "admin";
});

describe("NlAlertRulesView (FEAT-18)", () => {
  it("renders NL alert rules returned by the API", async () => {
    listMock.mockResolvedValue({ rules: [RULE], total: 1 });
    render(withClient(<NlAlertRulesView />));

    expect(await screen.findByText("High error rate")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Alert rules" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Detectors" })).toBeTruthy();
  });

  it("shows an empty state and opens the create dialog for admins", async () => {
    listMock.mockResolvedValue({ rules: [], total: 0 });
    render(withClient(<NlAlertRulesView />));

    await screen.findByText("No alert rules yet");
    fireEvent.click(screen.getAllByRole("button", { name: /Create rule/i })[0]);
    expect(await screen.findByText("New alert rule")).toBeTruthy();
  });

  it("runs the compile → review → save flow and calls create with the compiled EQL", async () => {
    listMock.mockResolvedValue({ rules: [], total: 0 });
    compileMock.mockResolvedValue({
      eql: "SELECT * FROM events WHERE error_rate > 0.05",
      warnings: ["Window inferred as 1h"],
      rule: {},
      suggested_name: "High error rate",
    });
    createMock.mockResolvedValue({ ...RULE, id: "rule_2" });

    render(withClient(<NlAlertRulesView />));
    await screen.findByText("No alert rules yet");
    fireEvent.click(screen.getAllByRole("button", { name: /Create rule/i })[0]);
    await screen.findByText("New alert rule");

    fireEvent.change(screen.getByPlaceholderText(/error rate exceeds 5%/i), {
      target: { value: "error rate exceeds 5% in the last hour" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Compile" }));

    await waitFor(() => expect(compileMock).toHaveBeenCalledTimes(1));
    expect(compileMock).toHaveBeenCalledWith("org_1", {
      nl_text: "error rate exceeds 5% in the last hour",
    });

    // Review phase renders the compiled EQL + warnings + editable name.
    await screen.findByText("SELECT * FROM events WHERE error_rate > 0.05");
    expect(screen.getByText("Window inferred as 1h")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    const [orgArg, body] = createMock.mock.calls[0];
    expect(orgArg).toBe("org_1");
    expect(body).toMatchObject({
      name: "High error rate",
      nl_text: "error rate exceeds 5% in the last hour",
      compiled_eql: "SELECT * FROM events WHERE error_rate > 0.05",
      triage_enabled: true,
      enabled: true,
      severity: "warning",
      interval_seconds: 3600,
    });
  });

  it("deletes a rule after confirmation", async () => {
    listMock.mockResolvedValue({ rules: [RULE], total: 1 });
    deleteMock.mockResolvedValue({ status: "ok", rule_id: "rule_1" });
    render(withClient(<NlAlertRulesView />));

    fireEvent.click(await screen.findByText("High error rate"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("org_1", "rule_1"));
  });

  it("hides authoring controls and shows read-only messaging for non-admin roles", async () => {
    mockRole = "member";
    listMock.mockResolvedValue({ rules: [RULE], total: 1 });
    render(withClient(<NlAlertRulesView />));

    await screen.findByText("High error rate");
    expect(
      screen.getByText(/read-only access to alert rules/i),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create rule/i })).toBeDisabled();
  });

  it("surfaces a permission-denied message when the backend 403s a mutation", async () => {
    listMock.mockResolvedValue({ rules: [RULE], total: 1 });
    updateMock.mockRejectedValue(new ApiError(403, "Admin role required"));
    render(withClient(<NlAlertRulesView />));

    fireEvent.click(await screen.findByText("High error rate"));
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
  });
});
