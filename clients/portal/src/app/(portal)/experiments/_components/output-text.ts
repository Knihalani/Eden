/** Extract displayable text from compare I/O blobs. */

export function outputText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as { output?: string };
      return String(parsed.output ?? v);
    } catch {
      return v;
    }
  }
  if (typeof v === "object" && v && "output" in v) {
    return String((v as { output?: unknown }).output ?? JSON.stringify(v));
  }
  return JSON.stringify(v);
}
