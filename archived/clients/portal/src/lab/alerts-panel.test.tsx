// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// FEAT-18 — self-serve NL-alert authoring UI. The backend
// (`eden.alerts.routes`) has full compile + CRUD endpoints for
// `nl_alert_rules`, but nothing in the portal called them (dead
// wrappers in `resources.ts`). `AlertRulesView` wires the `Rules` tab
// of the Inbox modal to those endpoints: list, compile-preview,
// create, enable/disable, delete.

const listMock = vi.fn();
const compileMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();

vi.mock("@/lib/api/resources", () => ({
  api: {
    listNlAlertRules: (...args: unknown[]) => listMock(...args),
    compileNlAlert: (...args: unknown[]) => compileMock(...args),
    createNlAlertRule: (...args: unknown[]) => createMock(...args),
    updateNlAlertRule: (...args: unknown[]) => updateMock(...args),
    deleteNlAlertRule: (...args: unknown[]) => deleteMock(...args),
  },
  alertsApi: {},
}));

vi.mock("@/hooks/use-org", () => ({
  useOrg: () => ({ currentOrg: { id: "org_1" } }),
}));

vi.mock("@/lab/lab-toast", () => ({
  useLabToast: () => ({ pushToast: vi.fn() }),
}));

import { AlertRulesView } from "./alerts-panel";

function withClient(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

const RULE = {
  id: "rule_1",
  name: "High error rate",
  nl_text: "alert me when error rate exceeds 5% in the last hour",
  compiled_eql: "SELECT * FROM traces WHERE error_rate > 0.05",
  triage_enabled: true,
  channels: { email: true },
  enabled: true,
  severity: "warning",
  last_fired_at: null,
  created_at: "2026-08-01T00:00:00Z",
};

beforeEach(() => {
  listMock.mockReset();
  compileMock.mockReset();
  createMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset();
});

describe("AlertRulesView (FEAT-18)", () => {
  it("renders NL alert rules returned by the API", async () => {
    listMock.mockResolvedValue({ rules: [RULE], total: 1 });
    render(withClient(<AlertRulesView orgId="org_1" />));

    expect(await screen.findByText("High error rate")).toBeTruthy();
    expect(
      screen.getByText("alert me when error rate exceeds 5% in the last hour"),
    ).toBeTruthy();
    expect(listMock).toHaveBeenCalledWith("org_1");
  });

  it("shows an empty state and opens the create dialog", async () => {
    listMock.mockResolvedValue({ rules: [], total: 0 });
    render(withClient(<AlertRulesView orgId="org_1" />));

    await screen.findByText("No alert rules yet");
    fireEvent.click(screen.getAllByRole("button", { name: /New rule/i })[0]);
    expect(await screen.findByText("New alert rule")).toBeTruthy();
  });

  it("compiles a rule from NL text before allowing save", async () => {
    listMock.mockResolvedValue({ rules: [], total: 0 });
    compileMock.mockResolvedValue({
      eql: "SELECT * FROM traces WHERE error_rate > 0.05",
      warnings: [],
      rule: {},
      suggested_name: "High error rate",
    });
    render(withClient(<AlertRulesView orgId="org_1" />));

    await screen.findByText("No alert rules yet");
    fireEvent.click(screen.getAllByRole("button", { name: /New rule/i })[0]);
    await screen.findByText("New alert rule");

    fireEvent.change(
      screen.getByPlaceholderText(/error rate exceeds 5%/i),
      { target: { value: "alert me when error rate exceeds 5% in the last hour" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => expect(compileMock).toHaveBeenCalledTimes(1));
    expect(compileMock).toHaveBeenCalledWith("org_1", {
      nl_text: "alert me when error rate exceeds 5% in the last hour",
    });
    expect(await screen.findByText("Compiled query")).toBeTruthy();
    // Name is prefilled from the compiler's suggested_name.
    expect(screen.getByDisplayValue("High error rate")).toBeTruthy();
  });

  it("creates a rule with the compiled EQL and delivery config", async () => {
    listMock.mockResolvedValue({ rules: [], total: 0 });
    compileMock.mockResolvedValue({
      eql: "SELECT * FROM traces WHERE error_rate > 0.05",
      warnings: ["No time bound — defaulting to 1h window"],
      rule: {},
      suggested_name: "High error rate",
    });
    createMock.mockResolvedValue({ ...RULE });
    render(withClient(<AlertRulesView orgId="org_1" />));

    await screen.findByText("No alert rules yet");
    fireEvent.click(screen.getAllByRole("button", { name: /New rule/i })[0]);
    await screen.findByText("New alert rule");

    fireEvent.change(
      screen.getByPlaceholderText(/error rate exceeds 5%/i),
      { target: { value: "alert me when error rate exceeds 5%" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByText("Compiled query");

    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    const [orgArg, body] = createMock.mock.calls[0];
    expect(orgArg).toBe("org_1");
    expect(body).toMatchObject({
      name: "High error rate",
      nl_text: "alert me when error rate exceeds 5%",
      compiled_eql: "SELECT * FROM traces WHERE error_rate > 0.05",
      severity: "warning",
      channels: { email: true, slack: false },
      interval_seconds: 3600,
      enabled: true,
    });
  });
});
