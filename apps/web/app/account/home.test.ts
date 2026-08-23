import {
  continuePath,
  destAfterAuth,
  fieldMessage,
  globalMessage,
  goDecorated,
  HOME,
  homeEmptyLine,
  homePath,
  homeStatus,
  homeViewTitle,
  navCurrent,
  needsWorkspaceGate,
  nextSsoStep,
  parseHomeView,
  SETUP,
  signedInDest,
  TOUR,
} from "./home";
import { expect, test } from "bun:test";

test("goDecorated uses relative push", () => {
  const calls: string[] = [];
  goDecorated((url) => url, (url) => calls.push(url), "/");
  expect(calls).toEqual(["/"]);
});

test("destAfterAuth sends a finished session home, not marketing", () => {
  expect(destAfterAuth({ currentTask: { key: "choose-organization" } })).toBe("/workspace");
  expect(destAfterAuth({ status: "pending" })).toBe("/workspace");
  expect(destAfterAuth(null)).toBe(HOME);
  expect(HOME).toBe("/home");
  expect(SETUP).toBe("/setup");
  expect(TOUR).toBe("/tour");
});

test("continuePath keeps pending or org-less sessions on workspace", () => {
  expect(continuePath("pending", "org_1")).toBe("/workspace");
  expect(continuePath("active", null)).toBe("/workspace");
  expect(continuePath("active", "org_1")).toBe("/home");
});

test("signedInDest and needsWorkspaceGate treat pending as needing a workspace", () => {
  expect(signedInDest({ sessionStatus: "pending" })).toBe("/workspace");
  expect(signedInDest({ isAuthenticated: true, sessionStatus: "active", orgId: "org_1" })).toBe("/home");
  expect(signedInDest({ isAuthenticated: true, sessionStatus: "active" })).toBe("/workspace");
  expect(signedInDest({ isAuthenticated: false, sessionStatus: "active" })).toBe(null);
  expect(needsWorkspaceGate({ sessionStatus: "pending", isAuthenticated: false })).toBe(true);
  expect(needsWorkspaceGate({ isAuthenticated: true, sessionStatus: "active", orgId: null })).toBe(true);
  expect(needsWorkspaceGate({ isAuthenticated: true, sessionStatus: "active", orgId: "org_1" })).toBe(false);
});

test("nextSsoStep waits for the Google handshake instead of failing empty", () => {
  expect(nextSsoStep({})).toBe("wait");
  expect(nextSsoStep({ signInStatus: "needs_identifier" })).toBe("wait");
  expect(nextSsoStep({ signInStatus: "needs_first_factor" })).toBe("wait");
  expect(nextSsoStep({ sessionStatus: "pending" })).toBe("session");
  expect(nextSsoStep({ sessionTask: "choose-organization" })).toBe("session");
  expect(nextSsoStep({ sessionStatus: "pending", signInStatus: "complete" })).toBe("finalize-in");
  expect(nextSsoStep({ signInStatus: "complete" })).toBe("finalize-in");
  expect(nextSsoStep({ signUpTransferable: true })).toBe("transfer-in");
  expect(nextSsoStep({ signInStatus: "needs_second_factor" })).toBe("mfa");
  expect(nextSsoStep({ signUpStatus: "missing_requirements" })).toBe("continue-up");
  expect(nextSsoStep({ existingSessionId: "sess_1" })).toBe("existing");
  expect(nextSsoStep({ signInStatus: "abandoned" })).toBe("fail");
});

test("field and global messages prefer longMessage", () => {
  expect(
    fieldMessage({ fields: { emailAddress: { longMessage: "Use a real email.", message: "bad" } } }, "emailAddress"),
  ).toBe("Use a real email.");
  expect(globalMessage({ global: [{ message: "Try again." }] }, "fallback")).toBe("Try again.");
  expect(globalMessage(null, "fallback")).toBe("fallback");
});

test("home views stay on /home and highlight the matching rail item", () => {
  expect(parseHomeView(null)).toBe("overview");
  expect(parseHomeView("requests")).toBe("requests");
  expect(homePath("overview")).toBe("/home");
  expect(homePath("workflows")).toBe("/home?view=workflows");
  expect(navCurrent("/home", "overview")).toBe("overview");
  expect(navCurrent("/home", "requests")).toBe("requests");
  expect(navCurrent("/setup", "overview")).toBe("setup");
  expect(navCurrent("/tour")).toBe("tour");
  expect(navCurrent("/live/wf_1")).toBe("workflows");
  expect(navCurrent("/request/req_1")).toBe("requests");
  expect(navCurrent("/workspace")).toBe(null);
  expect(homeViewTitle("overview")).toBe("Home");
  expect(homeStatus({ requests: [], workflows: [] })).toBe("Empty until you wrap");
  expect(homeStatus({ requests: [{}], workflows: [] })).toBe("1 request waiting");
  expect(homeEmptyLine("overview")).toBe("Requests and live tools land here after you wrap.");
  expect(homeEmptyLine("requests")).toBe("Nothing waiting. New compile requests land here.");
  expect(homeEmptyLine("workflows")).toBe("No live tools yet. Approve a request and it shows up here.");
  expect(homeEmptyLine("overview", true)).toBe("Couldn’t load activity.");
});
