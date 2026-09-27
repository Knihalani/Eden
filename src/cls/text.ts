export const STOP = new Set<string>();

export function stem(w0: string): string {
  return String(w0 ?? "");
}

export function contentToks(_s: string): string[] {
  return [];
}

export function properNames(_s: string): string[] {
  return [];
}

export function codeToks(_s: string): string[] {
  return [];
}
