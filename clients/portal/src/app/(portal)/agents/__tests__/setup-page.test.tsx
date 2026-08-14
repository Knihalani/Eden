// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANNOT_TELL_BANNER, INVITE_EDEN_COPY, LISTENING_BANNER } from "../help-copy";

const slackState = {
  connected: false as boolean,
  channels: [] as { id: string; name: string; is_private: boolean; is_member: boolean }[],
  users: [] as { id: string; name: string }[],
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/agents/new",
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/hooks/use-org", () => ({
  useOrg: () => ({ currentOrg: { id: "org_1" } }),
}));

vi.mock("@/hooks/use-api-query", () => ({
  useOrgQuery: (key: readonly unknown[]) => {
    const blob = JSON.stringify(key);
    if (blob.includes("slackInstall")) {
      return {
        data: slackState.connected ? { team_id: "T1", team_name: "Acme" } : null,
        isLoading: false,
        isError: false,
        error: null,
        refetch: vi.fn(),
      };
    }
    if (blob.includes("slackChannels")) {
      return {
        data: slackState.channels,
        isLoading: false,
        isError: false,
        error: null,
        refetch: vi.fn(),
      };
    }
    if (blob.includes("slackUsers")) {
      return {
        data: slackState.users,
        isLoading: false,
        isError: false,
        error: null,
        refetch: vi.fn(),
      };
    }
    return { data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() };
  },
}));

vi.mock("@/lib/api/resources", () => ({
  agentsApi: { register: vi.fn() },
  slackApi: {
    install: vi.fn(),
    channels: vi.fn(),
    users: vi.fn(),
    authorize: vi.fn(),
    setup: vi.fn(),
  },
}));

vi.mock("@/lib/api/core", () => ({
  fetchApi: vi.fn(),
}));

vi.mock("@/components/ds/primitives", () => ({
  PageHeader: ({ title, actions }: { title: string; actions?: unknown }) => (
    <header>
      <h1>{title}</h1>
      {actions}
    </header>
  ),
}));

import { SetupClient } from "../new/setup-client";

afterEach(() => {
  cleanup();
  slackState.connected = false;
  slackState.channels = [];
  slackState.users = [];
});

describe("agent setup page", () => {
  it("requires name and job sentence to save", () => {
    render(<SetupClient />);
    const save = screen.getByTestId("setup-save");
    expect(save).toBeDisabled();
    expect(screen.getByLabelText("Agent name")).toBeInTheDocument();
    expect(screen.getByLabelText("Job sentence")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Refund helper" } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Job sentence"), { target: { value: "short" } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Job sentence"), {
      target: { value: "take refunds off Y" },
    });
    expect(save).not.toBeDisabled();
  });

  it("shows cannot-tell when Slack is skipped or watch channels are zero", () => {
    render(<SetupClient />);
    expect(screen.getByTestId("setup-banner")).toHaveTextContent(CANNOT_TELL_BANNER);
    expect(screen.queryByLabelText("Y Slack user")).not.toBeInTheDocument();
  });

  it("shows listening copy after watch channels are picked", () => {
    slackState.connected = true;
    slackState.channels = [{ id: "C1", name: "ops", is_private: false, is_member: true }];
    render(<SetupClient />);
    expect(screen.getByTestId("setup-banner")).toHaveTextContent(CANNOT_TELL_BANNER);
    fireEvent.click(screen.getByLabelText("Watch #ops"));
    expect(screen.getByTestId("setup-banner")).toHaveTextContent(LISTENING_BANNER);
  });

  it("has no file picker, path field, or AGENTS.md", () => {
    slackState.connected = true;
    slackState.channels = [{ id: "C1", name: "ops", is_private: false, is_member: true }];
    const { container } = render(<SetupClient />);
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(container.textContent).not.toMatch(/AGENTS\.md/);
    expect(container.textContent).not.toMatch(/target_path/);
    expect(container.querySelector('input[name="path"]')).toBeNull();
    expect(container.querySelector('input[name="target_path"]')).toBeNull();
    expect(screen.getByLabelText("Notify Slack channel")).toBeInTheDocument();
    expect(screen.getByLabelText("Y Slack user")).toBeInTheDocument();
    expect(screen.getByText(INVITE_EDEN_COPY)).toBeInTheDocument();
  });
});
