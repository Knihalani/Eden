import { test, expect } from "@playwright/test";

test.describe("Marketplace journey", () => {
  test("renders the marketplace page with search and filters", async ({ page }) => {
    await page.goto("/marketplace");
    // The portal layout redirects to /login when unauthenticated; this
    // test runs in CI with a pre-baked session. If the redirect
    // happens, we still want to assert the page is reachable.
    if (page.url().includes("/login")) {
      test.skip(true, "no pre-baked session in this environment");
    }
    await expect(page.getByRole("heading", { name: /marketplace/i })).toBeVisible();
    await expect(page.getByRole("searchbox", { name: /search marketplace/i })).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: /quality filter/i })).toBeVisible();
  });

  test("narrowing by search updates the result list", async ({ page }) => {
    await page.goto("/marketplace");
    if (page.url().includes("/login")) test.skip(true, "no session");

    const initial = await page.locator("section[aria-label='Marketplace results'] a").count();
    if (initial === 0) test.skip(true, "no cards in the test org");

    await page.getByRole("searchbox", { name: /search marketplace/i }).fill("nonexistent_xyz");
    await expect(page.getByText(/no environments match your filters/i)).toBeVisible();
  });

  test("quality filter narrows to high-only when selected", async ({ page }) => {
    await page.goto("/marketplace");
    if (page.url().includes("/login")) test.skip(true, "no session");

    await page.getByRole("radio", { name: /^high$/ }).check();
    // The cards, if any, should all have a "high" quality badge.
    const cards = page.locator("section[aria-label='Marketplace results'] a");
    const count = await cards.count();
    for (let i = 0; i < count; i += 1) {
      await expect(cards.nth(i)).toContainText(/high/i);
    }
  });
});
