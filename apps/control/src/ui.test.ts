import { expect, test } from "bun:test";
import { Store } from "./store";
import { livePage } from "./ui";

test("empty live page titles 0 programs, not Live tools", () => {
  const html = livePage(new Store(":memory:"));
  expect(html).toContain("<h1>0 programs</h1>");
  expect(html).toContain(">0 programs</a>");
  expect(html).toContain("0 programs. Approve one from the inbox.");
  expect(html).not.toMatch(/<h1>Live tools<\/h1>/);
  expect(html).not.toMatch(/>Live tools<\/a>/);
});
