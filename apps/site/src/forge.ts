export function forgeIssue(n: string) {
  return {
    number: Number(n),
    title: `Cannot deploy widget ${n}`,
    body: "The deploy pipeline fails when the lockfile drifts. ".repeat(40),
    user: { login: "octocat", id: 1, type: "User", site_admin: false },
    labels: [
      { name: "bug", color: "d73a4a", description: "something is broken" },
      { name: "deploy", color: "0e8a16", description: "release path" },
    ],
    state: "open",
    comments: 12,
    created_at: "2026-08-01T00:00:00Z",
  };
}

export function forgeComments(n: string) {
  return Array.from({ length: 12 }, (_, i) => ({
    id: 1000 + i,
    user: { login: i % 2 ? "alice" : "bob", id: i, type: "User", site_admin: false },
    body: `Comment ${i} on issue ${n}: we should pin the lockfile and rerun the pipeline. `.repeat(8),
    created_at: "2026-08-02T00:00:00Z",
  }));
}

export function forgePull(n: string) {
  return {
    number: Number(n),
    title: `Fix deploy for ${n}`,
    body: "Pins lockfile and retries status checks. ".repeat(30),
    user: { login: "octocat", id: 1, type: "User", site_admin: false },
    merged: false,
    draft: false,
    head: { sha: "abc" + n, ref: "fix/deploy" },
    base: { ref: "main" },
  };
}

export function forgeReviews(n: string) {
  return Array.from({ length: 6 }, (_, i) => ({
    id: 2000 + i,
    user: { login: "reviewer" + i, id: 10 + i, type: "User", site_admin: false },
    state: i === 0 ? "CHANGES_REQUESTED" : "COMMENTED",
    body: `Review note ${i} for PR ${n}. `.repeat(12),
  }));
}

export function forgeStatus() {
  return {
    state: "pending",
    statuses: Array.from({ length: 8 }, (_, i) => ({
      context: `ci/${i}`,
      state: i < 6 ? "success" : "pending",
      description: "check " + i,
      target_url: "https://ci.example/" + i,
    })),
  };
}

export function forgeRuns(n: string) {
  return {
    total_count: 4,
    workflow_runs: Array.from({ length: 4 }, (_, i) => ({
      id: 9000 + i,
      name: i === 0 ? "deploy" : "test",
      conclusion: i === 0 ? "failure" : "success",
      head_branch: "fix/deploy",
      display_title: `run ${i} for ${n}`,
      html_url: "https://ci.example/run/" + i,
    })),
  };
}

export function forgeFiles(n: string) {
  const count = (Number(n) % 7) + 3;
  return Array.from({ length: count }, (_, i) => ({
    filename: `src/f${i}-${n}.ts`,
    status: "modified",
    additions: i + 1,
    deletions: 0,
  }));
}

export function shopOrder(n: string) {
  const id = Number(n);
  return {
    id,
    title: `Order ${n}`,
    total: id * 10 + 5,
    status: id % 2 === 0 ? "paid" : "open",
  };
}

export function shopItems(n: string) {
  return [
    { sku: `SKU-${n}-A`, qty: 2 },
    { sku: `SKU-${n}-B`, qty: 1 },
  ];
}

export function shopCustomer(n: string) {
  return {
    id: Number(n),
    name: `Customer ${n}`,
    email: `c${n}@example.com`,
  };
}

export function shopCustomerOrders(n: string) {
  const id = Number(n);
  return [
    { id: id * 10, total: 50 },
    { id: id * 10 + 1, total: 25 },
  ];
}

export function shopTicket(n: string) {
  return {
    id: Number(n),
    title: `Ticket ${n}`,
    state: Number(n) % 3 === 0 ? "closed" : "open",
  };
}

export function shopTicketComments(n: string) {
  return Array.from({ length: (Number(n) % 3) + 1 }, (_, i) => ({
    id: Number(n) * 10 + i,
    body: `note ${i} on ${n}`,
  }));
}

export function handleForge(url: URL): Response | null {
  const p = url.pathname;
  if (p.startsWith("/shop/")) {
    const n = p.match(/\/(\d+)(?:\/|$)/)?.[1] || "1";
    if (p.includes("/orders/") && p.endsWith("/items")) return json(shopItems(n));
    if (/\/orders\/\d+$/.test(p)) return json(shopOrder(n));
    if (p.includes("/customers/") && p.endsWith("/orders")) return json(shopCustomerOrders(n));
    if (/\/customers\/\d+$/.test(p)) return json(shopCustomer(n));
    if (p.includes("/tickets/") && p.endsWith("/comments")) return json(shopTicketComments(n));
    if (/\/tickets\/\d+$/.test(p)) return json(shopTicket(n));
    return json({ error: "unknown_shop_path" });
  }
  if (!p.startsWith("/forge/") && !p.includes("/forge/")) return null;
  const n = p.match(/\/(\d+)(?:\/|$)/)?.[1] || url.searchParams.get("pr") || "1";
  if (p.includes("/files")) return json(forgeFiles(n));
  if (p.includes("/comments")) return json(forgeComments(n));
  if (p.includes("/reviews")) return json(forgeReviews(n));
  if (p.includes("/status")) return json(forgeStatus());
  if (p.includes("/actions/runs")) return json(forgeRuns(n));
  if (p.includes("/pulls/")) return json(forgePull(n));
  if (p.includes("/issues/")) return json(forgeIssue(n));
  return null;
}

function json(data: unknown) {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}
