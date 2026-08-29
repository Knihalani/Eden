import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { continuePath, destAfterAuth, destAfterWorkspace, signedInDest } from "./home";
import { productGate } from "./route";

function gate(path: string, auth: { isAuthenticated?: boolean | null; sessionStatus?: string | null; orgId?: string | null }) {
  return productGate(path, auth);
}

test("logged-out landing stays; product paths leave marketing", () => {
  const out = { isAuthenticated: false, sessionStatus: null, orgId: null };
  expect(gate("/", out)).toBe(null);
  expect(gate("/proof", out)).toBe(null);
  expect(gate("/isolation", out)).toBe(null);
  expect(gate("/pack", out)).toBe(null);
  expect(gate("/sign-in", out)).toBe(null);
  expect(gate("/sign-up", out)).toBe(null);
  expect(gate("/sso-callback", out)).toBe(null);
  expect(gate("/home", out)).toBe("/");
  expect(gate("/tour", out)).toBe("/");
  expect(gate("/setup", out)).toBe("/");
  expect(gate("/request/r1", out)).toBe("/");
  expect(gate("/live/w1", out)).toBe("/");
  expect(gate("/workspace", out)).toBe("/sign-in");
});

test("in-product never stays on marketing or auth pages", () => {
  const inn = { isAuthenticated: true, sessionStatus: "active", orgId: "org_1" };
  expect(gate("/", inn)).toBe("/home");
  expect(gate("/sign-in", inn)).toBe("/home");
  expect(gate("/sign-up", inn)).toBe("/home");
  expect(gate("/home", inn)).toBe(null);
  expect(gate("/setup", inn)).toBe(null);
  expect(gate("/tour", inn)).toBe(null);
  expect(gate("/proof", inn)).toBe(null);
});

test("pending or org-less sessions go to workspace, not Home", () => {
  const pending = { isAuthenticated: false, sessionStatus: "pending", orgId: null };
  const noOrg = { isAuthenticated: true, sessionStatus: "active", orgId: null };
  expect(gate("/home", pending)).toBe("/workspace");
  expect(gate("/tour", pending)).toBe("/workspace");
  expect(gate("/setup", pending)).toBe("/workspace");
  expect(gate("/sign-in", pending)).toBe("/workspace");
  expect(gate("/sign-up", pending)).toBe("/workspace");
  expect(gate("/workspace", pending)).toBe(null);
  expect(gate("/home", noOrg)).toBe("/workspace");
  expect(gate("/sign-in", noOrg)).toBe("/workspace");
  expect(gate("/", noOrg)).toBe("/workspace");
});

test("sign-up finalize with an org opens the tour; sign-in goes Home", () => {
  expect(destAfterAuth({ status: "active" }, "up")).toBe("/tour");
  expect(destAfterAuth({ status: "active" }, "in")).toBe("/home");
  expect(destAfterAuth({ currentTask: { key: "choose-organization" } }, "up")).toBe("/workspace");
  expect(destAfterAuth({ status: "pending" }, "in")).toBe("/workspace");
  expect(continuePath("active", "org_1", "up")).toBe("/tour");
  expect(continuePath("active", "org_1", "in")).toBe("/home");
  expect(continuePath("pending", "org_1")).toBe("/workspace");
  expect(destAfterWorkspace("create")).toBe("/tour");
  expect(destAfterWorkspace("invite")).toBe("/tour");
  expect(destAfterWorkspace("select")).toBe("/home");
  expect(destAfterWorkspace("continue")).toBe("/home");
});

test("landing and proof stay free of invented customers and unproven percents", () => {
  const app = join(import.meta.dir, "..");
  const landing = [
    readFileSync(join(app, "(marketing)/page.tsx"), "utf8"),
    readFileSync(join(app, "landing/hero.tsx"), "utf8"),
    readFileSync(join(app, "landing/story.tsx"), "utf8"),
    readFileSync(join(app, "landing/close.tsx"), "utf8"),
  ].join("\n");
  const proof = readFileSync(join(app, "(notes)/proof/page.tsx"), "utf8");
  expect(landing).not.toMatch(/N teams|98%|SOC2 certified|6\.67|−9\.1|\+2\.8%/);
  expect(landing).not.toMatch(/from "@clerk/);
  expect(proof).not.toMatch(/Sign up|from "@clerk"/);
  expect(landing).toContain("Making your agents more deterministic.");
});

test("PasswordField is the password control on sign-up and sign-in", () => {
  const signup = readFileSync(join(import.meta.dir, "../sign-up/form.tsx"), "utf8");
  const signin = readFileSync(join(import.meta.dir, "../sign-in/form.tsx"), "utf8");
  expect(signup).toContain("PasswordField");
  expect(signin).toContain("PasswordField");
  expect(signin.split("PasswordField").length).toBeGreaterThan(2);
});

test("setup is a slim onboarding panel, not a dashboard rail", () => {
  const chrome = readFileSync(join(import.meta.dir, "../home/chrome.tsx"), "utf8");
  const route = readFileSync(join(import.meta.dir, "route.ts"), "utf8");
  expect(chrome).toContain("isSlimPath(path)");
  expect(route).toContain("at(path, SETUP)");
  expect(route).not.toMatch(/from ["']\.\/home["']/);
  expect(route).not.toMatch(/from ["']@eden\/ir["']|from ["']node:crypto["']/);
});

test("pending SSO stays on the callback; notes stay even in-product", () => {
  const pending = { isAuthenticated: false, sessionStatus: "pending", orgId: null };
  expect(gate("/sso-callback", pending)).toBe(null);
  expect(productGate({ path: "/proof", isAuthenticated: true, sessionStatus: "active", orgId: "org_1" })).toBe(null);
});

test("story invoice is product copy; landing and proof invent 0 customers", async () => {
  const app = join(import.meta.dir, "..");
  const story = readFileSync(join(app, "landing/story.tsx"), "utf8");
  expect(story).toMatch(/invoice/);
  expect(story).not.toMatch(/Claude Code invoice|billed invoice|\$99/);
  const { CUSTOMERS } = await import("../(notes)/proof/copy");
  expect(CUSTOMERS.length).toBe(0);
});

test("PasswordField show/hide is a button; tour is 3 beats with Skip", () => {
  const field = readFileSync(join(import.meta.dir, "password-field.tsx"), "utf8");
  expect(field).toContain('type="button"');
  expect(field).toContain("aria-pressed");
  expect(field).toContain("Show");
  expect(field).toContain("Hide");
  const tour = readFileSync(join(import.meta.dir, "../home/tour.tsx"), "utf8");
  expect(tour.match(/title:/g)?.length).toBe(3);
  expect(tour).toContain("Skip");
  expect(tour).toContain("Open setup");
});

test("middleware still exempts wrap, health, and notes; no Hub or Reach chrome", () => {
  const mw = readFileSync(join(import.meta.dir, "../../middleware.ts"), "utf8");
  expect(mw).toContain("productGate");
  expect(mw).toMatch(/v1\(\?:\/\|\$\)/);
  expect(mw).toMatch(/health\(\?:\/\|\$\)/);
  expect(mw).toMatch(/\/proof\(\.\*\)/);
  const chrome = readFileSync(join(import.meta.dir, "../home/chrome.tsx"), "utf8");
  const tour = readFileSync(join(import.meta.dir, "../home/tour.tsx"), "utf8");
  const prompt = readFileSync(join(import.meta.dir, "../home/prompt.tsx"), "utf8");
  expect(`${chrome}\n${tour}\n${prompt}`).not.toMatch(/\bHub\b|\bReach\b/);
});
