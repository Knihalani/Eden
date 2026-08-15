/** Laptop runner for leftover cwd/fs/docker steps. Idle-disconnects. */
export async function startRunner(baseUrl: string, apiKey: string): Promise<void> {
  const url = baseUrl.replace(/^http/, "ws") + "/runner";
  void url;
  void apiKey;
}

if (import.meta.main) {
  console.log("eden runner: connect on SessionStart, drop after ~2 min idle");
}
