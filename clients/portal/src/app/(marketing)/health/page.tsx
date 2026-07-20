import { redirect } from "next/navigation";

/**
 * `/health` is a public alias of the marketing status page.
 *
 * Without this route, unknown-path catch-alls historically wrapped
 * `/health` in portal chrome and rendered a permanent “Loading”
 * soft-404 (HTTP 200). Keep the alias so ops bookmarks and external
 * links land on an honest status surface — not a fake portal shell.
 */
export default function HealthAliasPage() {
  redirect("/status");
}
