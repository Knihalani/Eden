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

export function handleForge(url: URL): Response | null {
  const p = url.pathname;
  const n = p.match(/\/(\d+)(?:\/|$)/)?.[1] || url.searchParams.get("pr") || "1";
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
