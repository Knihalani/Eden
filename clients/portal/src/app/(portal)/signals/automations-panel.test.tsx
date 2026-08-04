// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// F61 — the Automations view wires the /signals surface to the real
// GET/POST /orgs/{org}/automations endpoints. These tests exercise the
// list render, the mode toggle, and the create round-trip against a
// mocked `automationsApi`.

const listMock = vi.fn();
const createMock = vi.fn();

vi.mock("@/lib/api/resources", () => ({
  automationsApi: {
    list: (...args: unknown[]) => listMock(...args),
    create: (...args: unknown[]) => createMock(...args),
  },
}));

vi.mock("@/hooks/use-org", () => ({
  useOrg: () => ({ currentOrg: { id: "org_1" } }),
}));

const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: () => null, toString: () => "" }),
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  usePathname: () => "/signals",
}));

import { AutomationsView } from "./automations-panel";

function withClient(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

const envelope = (automations: unknown[]) => ({
  status: "ok",
  feature: "f61",
  live: true,
  trace_id: "w6_x",
  timestamp: "",
  data: { automations },
});

const AUTOMATION = {
  id: "auto_1",
  name: "Route low-score turns",
  trigger_type: "score_threshold",
  trigger_config: { threshold: 0.4 },
  action_type: "dataset",
  action_config: {},
  enabled: true,
};

beforeEach(() => {
  listMock.mockReset();
  createMock.mockReset();
  replaceMock.mockReset();
});

describe("AutomationsView (F61)", () => {
  it("renders automations returned by the API", async () => {
    listMock.mockResolvedValue(envelope([AUTOMATION]));
    render(withClient(<AutomationsView />));

    expect(
      await screen.findByText("Route low-score turns"),
    ).toBeTruthy();
    // Mode toggle is present (no new nav leaf).
    expect(screen.getByRole("tab", { name: "Automations" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Detectors" })).toBeTruthy();
  });

  it("shows an empty state and opens the create dialog", async () => {
    listMock.mockResolvedValue(envelope([]));
    render(withClient(<AutomationsView />));

    await screen.findByText("No automations yet");
    fireEvent.click(
      screen.getAllByRole("button", { name: /Create automation/i })[0],
    );
    expect(await screen.findByText("New automation")).toBeTruthy();
  });

  it("creates an automation with the composed trigger/action body", async () => {
    listMock.mockResolvedValue(envelope([]));
    createMock.mockResolvedValue({
      data: { automation: { ...AUTOMATION, id: "auto_2" } },
    });
    render(withClient(<AutomationsView />));

    await screen.findByText("No automations yet");
    fireEvent.click(
      screen.getAllByRole("button", { name: /Create automation/i })[0],
    );
    await screen.findByText("New automation");

    fireEvent.change(
      screen.getByPlaceholderText(/Route low-score turns to review/i),
      { target: { value: "My automation" } },
    );
    fireEvent.change(screen.getByLabelText("Score threshold"), {
      target: { value: "0.7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    const [orgArg, body] = createMock.mock.calls[0];
    expect(orgArg).toBe("org_1");
    expect(body).toMatchObject({
      name: "My automation",
      trigger_type: "score_threshold",
      trigger_config: { threshold: 0.7 },
      action_type: "dataset",
    });
  });
});
