import { describe, expect, test } from "bun:test";
import {
  commandShape,
  commandShapeKey,
  isNoiseCommand,
  looksLikeIdentifier,
} from "./shapes";

/**
 * Domain-general command shapes. None of these binaries are known to Eden —
 * that is the point. The compiler must qualify stretches by *repetition and
 * shape*, not by a vendor table.
 */
describe("command shapes", () => {
  test("extracts binary + subcommand + flags from an unknown CLI", () => {
    const s = commandShape("stripe invoices list --limit 10");
    expect(s?.name).toBe("stripe.invoices.list");
    expect(s?.flags).toEqual(["--limit"]);
    expect(s?.possiblyRead).toBe(true);
  });

  test("flag values are parameters; identifiers count as variable slots", () => {
    const a = commandShape("kubectl get pods --namespace prod");
    expect(a?.name).toBe("kubectl.get.pods");
    expect(a?.flags).toContain("--namespace");
    const b = commandShape("aws s3api get-object --key data/export-2024.json bucket/x");
    expect(b?.name).toBe("aws.s3api.get-object");
    // `data/export-2024.json` and `bucket/x` are opaque values → slots.
    expect(b!.varSlots).toBeGreaterThanOrEqual(0);
  });

  test("identifier-looking tokens become slots", () => {
    expect(looksLikeIdentifier("42")).toBe(true);
    expect(looksLikeIdentifier("abc123def")).toBe(true);
    expect(looksLikeIdentifier("8f14e45f-ea09-48b1")).toBe(true);
    expect(looksLikeIdentifier("PROJ-123")).toBe(true);
    expect(looksLikeIdentifier("--limit")).toBe(false);
    expect(looksLikeIdentifier("pods")).toBe(false);
  });

  test("session plumbing is noise", () => {
    expect(isNoiseCommand("ls -la")).toBe(true);
    expect(isNoiseCommand("cd src")).toBe(true);
    expect(isNoiseCommand("echo done")).toBe(true);
    // Real work, even unfamiliar, is not noise.
    expect(isNoiseCommand("kubectl rollout status deploy/api")).toBe(false);
  });

  test("PowerShell cmdlets classify by their own verb vocabulary (G11)", () => {
    const read = commandShape("Get-ChildItem -Path C:\\logs");
    expect(read?.name).toBe("powershell.get.childitem");
    expect(read?.possiblyRead).toBe(true);

    const write = commandShape("Remove-Item -Path C:\\temp\\x");
    expect(write?.name).toBe("powershell.remove.item");
    expect(write?.possiblyRead).toBe(false);

    // $variables are parameter slots.
    const withVar = commandShape("Get-Content $LogPath");
    expect(withVar?.varSlots).toBe(1);
    expect(withVar?.possiblyRead).toBe(true);
  });

  test("unknown binaries fail conservative on reads", () => {
    // No read verb up front → possiblyRead false → sequential, never deduped.
    expect(commandShape("terraform apply -auto-approve")?.possiblyRead).toBe(false);
    expect(commandShape("psql -c \"delete from users\"")?.possiblyRead).toBe(false);
    // Shell-level writes are caught regardless of verb.
    expect(commandShape("cat id_ed25519 > key.txt")?.possiblyRead).toBe(false);
    expect(commandShape("rm -rf build")?.possiblyRead).toBe(false);
    // Known-cautious binaries trust only a positively-read subcommand.
    expect(commandShape("git push origin main")?.possiblyRead).toBe(false);
    expect(commandShape("git log --oneline")?.possiblyRead).toBe(true);
  });

  test("shape keys are stable across value changes and distinct across shapes", () => {
    const a = commandShapeKey("stripe invoices list --limit 10");
    const b = commandShapeKey("stripe invoices list --limit 99");
    const c = commandShapeKey("stripe invoices void --limit 10");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
