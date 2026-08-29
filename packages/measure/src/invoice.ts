/**
 * Live-invoice vs analogue cents (Wave 8.1 leftover 1).
 *
 * A file is live only when it carries provider usage (tokens or billed USD)
 * and does not mention TURN_CENTS / ISLAND_CENTS. Missing file → retired,
 * never a synthetic Claude bill.
 */
export type InvoiceSource = "live-invoice" | "analogue-headless" | "missing";

export type InvoiceCell = {
  source: InvoiceSource;
  cents: number | null;
  note: string;
};

const ANALOGUE = /TURN_CENTS|ISLAND_CENTS|analogue|headless replica/i;

export function parseInvoice(raw: string | null | undefined): InvoiceCell {
  if (raw == null || !String(raw).trim()) {
    return { source: "missing", cents: null, note: "No invoice file. Live-invoice claim retired." };
  }
  const text = String(raw);
  if (ANALOGUE.test(text) && !hasProviderUsage(text)) {
    return {
      source: "analogue-headless",
      cents: centsFromText(text),
      note: "Analogue TURN_CENTS / ISLAND_CENTS. Not a live Claude Code invoice.",
    };
  }
  if (!hasProviderUsage(text)) {
    return { source: "missing", cents: null, note: "No provider usage fields. Live-invoice claim retired." };
  }
  return {
    source: "live-invoice",
    cents: centsFromText(text),
    note: "Provider usage present.",
  };
}

function hasProviderUsage(text: string): boolean {
  return (
    /"input_tokens"\s*:/i.test(text) ||
    /"prompt_tokens"\s*:/i.test(text) ||
    /"cost_usd"\s*:/i.test(text) ||
    /"billed_usd"\s*:/i.test(text) ||
    /\bcost_usd\b/i.test(text)
  );
}

function centsFromText(text: string): number | null {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const cents = Number(json.cents);
    if (Number.isFinite(cents)) return cents;
    const usd = Number(json.cost_usd ?? json.billed_usd);
    if (Number.isFinite(usd)) return Math.round(usd * 100);
  } catch {
    /* CSV / prose */
  }
  const m = /cents["\s:=]+([0-9.]+)/i.exec(text);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function liveInvoiceStatus(cell: InvoiceCell): "measured" | "retired" {
  return cell.source === "live-invoice" ? "measured" : "retired";
}
