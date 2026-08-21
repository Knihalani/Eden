import { readCachedAvatar, rememberAvatar, sizedAvatar } from "./portrait";
import { expect, test } from "bun:test";

test("sizedAvatar asks Clerk for a 80px crop", () => {
  expect(sizedAvatar("https://img.clerk.com/abc?foo=1")).toBe(
    "https://img.clerk.com/abc?foo=1&width=80&height=80&fit=crop",
  );
});

test("sizedAvatar leaves non-Clerk URLs alone", () => {
  expect(sizedAvatar("https://example.com/me.png")).toBe("https://example.com/me.png");
});

test("rememberAvatar only stores https URLs", () => {
  const mem = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => mem.get(key) ?? null,
      setItem: (key: string, value: string) => {
        mem.set(key, value);
      },
      removeItem: (key: string) => {
        mem.delete(key);
      },
    },
  });
  rememberAvatar("https://img.clerk.com/me.png", "user_1");
  expect(readCachedAvatar("user_1")).toBe("https://img.clerk.com/me.png");
  expect(readCachedAvatar("user_2")).toBe(null);
  rememberAvatar("javascript:alert(1)", "user_1");
  expect(readCachedAvatar("user_1")).toBe("https://img.clerk.com/me.png");
});
