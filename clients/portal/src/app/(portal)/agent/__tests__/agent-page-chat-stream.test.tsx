// @vitest-environment jsdom
/**
 * Regression test for F41-4: the agent page's assistant-chat SSE call
 * used to bypass ``fetchApi`` entirely via a hand-rolled ``fetch()``
 * (missing the shared auth-bearer-attach/timeout/retry pipeline). It
 * now routes through ``fetchApi``'s combined ``stream: true`` (skip
 * the 30s default timeout for a long-lived read) + ``raw: true``
 * (hand back the live, unread ``Response``) mode.
 *
 * This mocks every heavy visual/data dependency down to a single
 * "Send" button wired to the real ``streamAssistantReply`` closure,
 * and asserts on the underlying (real) ``fetchApi`` → mocked
 * ``global.fetch`` call it produces.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/hooks/use-org", () => ({
  useOrg: () => ({ currentOrg: { id: "org_1" } }),
}));

vi.mock("@/lab/lab-toast", () => ({
  useLabToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("@/lab/agent-scope", () => ({
  useQueryPatch: () => vi.fn(),
}));

vi.mock("@/lib/api/portal", () => ({
  portalApi: { assistantThreads: vi.fn(async () => []) },
}));

vi.mock("@/components/ds/primitives", () => ({
  PageHeader: () => null,
}));

vi.mock("@/components/shell/query-error-panel", () => ({
  QueryErrorPanel: () => null,
  QueryLoadingPanel: () => null,
}));

vi.mock("@/lab/agent/agent-chrome", async () => {
  const actual = await vi.importActual<typeof import("@/lab/agent/agent-chrome")>(
    "@/lab/agent/agent-chrome",
  );
  return {
    ...actual,
    AgentModeNav: () => null,
  };
});

vi.mock("@/lab/agent/agent-chat-view", () => ({
  AgentHistoryRail: () => null,
  // Minimal stand-in: a controlled draft input + send button, mirroring
  // the real composer's two-step (type, then send) interaction — the
  // real `send()` closes over the `draft` prop from the component's
  // last render, so setting draft and sending must be two separate
  // React commits, not one synchronous batch.
  AgentChatStream: ({
    thread,
    draft,
    onSend,
    onDraftChange,
  }: {
    thread?: { id?: string };
    draft: string;
    onSend: () => void;
    onDraftChange: (v: string) => void;
  }) => (
    <div data-active-thread={thread?.id ?? ""}>
      <input
        aria-label="draft"
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
      />
      <button type="button" onClick={onSend}>
        send-test-message
      </button>
    </div>
  ),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response("data: {\"type\":\"summary\"}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  (window as unknown as { Clerk?: unknown }).Clerk = {
    session: { getToken: async () => "tok_abc" },
  };
});

describe("agent page — assistant chat stream via fetchApi (F41-4)", () => {
  it("sends the chat request through fetchApi (same-origin API_BASE, JSON body, SSE Accept header, auth bearer attached) instead of a bare global fetch()", async () => {
    const user = userEvent.setup();
    const { default: LabAgentPage } = await import("../page");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <LabAgentPage />
      </QueryClientProvider>,
    );

    const button = await screen.findByText("send-test-message");
    // The page only wires up an active thread after its boot effect
    // resolves the (mocked, instant) assistant-threads query — wait
    // for that so `appendExchange`'s `!activeId` guard doesn't
    // silently swallow the click.
    await waitFor(() =>
      expect(button.parentElement?.getAttribute("data-active-thread")).not.toBe(""),
    );
    const input = screen.getByLabelText("draft");
    await user.type(input, "Hello assistant");
    await user.click(button);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/orgs\/org_1\/ai\/chat$/);
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("content-type")).toBe("application/json");
    // Only fetchApi's shared pipeline attaches this — the old
    // hand-rolled fetch() never did.
    expect(headers.get("authorization")).toBe("Bearer tok_abc");
    expect(JSON.parse(init.body as string)).toMatchObject({
      message: "Hello assistant",
    });
  }, 20_000);
});
