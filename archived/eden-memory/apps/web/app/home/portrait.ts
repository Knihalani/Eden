export type Portrait = {
  initial: string;
  imageUrl: string | null;
};

export const EMPTY_PORTRAIT: Portrait = { initial: "E", imageUrl: null };

const AVATAR_KEY = "eden:avatar:v2";

type StoredAvatar = { owner: string; url: string };

export function sizedAvatar(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("clerk") || parsed.hostname.includes("gravatar")) {
      parsed.searchParams.set("width", "80");
      parsed.searchParams.set("height", "80");
      parsed.searchParams.set("fit", "crop");
    }
    return parsed.href;
  } catch {
    return url;
  }
}

function readStore(): StoredAvatar | null {
  try {
    const raw = globalThis.localStorage.getItem(AVATAR_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAvatar;
    if (!parsed?.url || !parsed.url.startsWith("https:")) return null;
    return { owner: parsed.owner ?? "", url: parsed.url };
  } catch {
    return null;
  }
}

export function readCachedAvatar(owner = ""): string | null {
  if (!owner) return null;
  const stored = readStore();
  if (!stored || stored.owner !== owner) return null;
  return stored.url;
}

export function rememberAvatar(url: string, owner = "") {
  if (!url.startsWith("https:")) return;
  try {
    globalThis.localStorage.setItem(AVATAR_KEY, JSON.stringify({ owner, url } satisfies StoredAvatar));
  } catch {
    /* quota / missing storage */
  }
}

export function forgetAvatar() {
  try {
    globalThis.localStorage.removeItem(AVATAR_KEY);
  } catch {
    /* missing storage */
  }
}
