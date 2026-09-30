/** Allowlisted tool docs + GitHub orgs/repos. Not an open GitHub crawl. */

export const GITHUB_TOOL_PREFIXES = [
  "/whatwg",
  "/oven-sh",
  "/denoland",
  "/rust-lang",
  "/golang",
  "/python",
  "/nodejs",
  "/git/git",
  "/kubernetes",
  "/facebook/react",
  "/vercel",
  "/microsoft/TypeScript",
  "/cli/cli",
  "/moby",
  "/ziglang",
  "/vuejs",
  "/sveltejs",
  "/angular",
  "/withastro",
  "/pypa",
  "/npm/cli",
  "/jqlang",
  "/stedolan",
  "/BurntSushi",
  "/sharkdp",
  "/junegunn",
  "/koalaman",
  "/astral-sh",
  "/pnpm",
  "/hashicorp",
  "/neovim",
  "/vim",
  "/tmux",
  "/fish-shell",
  "/ggreer",
  "/dandavison",
  "/ClementTsang",
  "/ajeetdsouza",
  "/starship",
  "/helix-editor",
  "/charmbracelet",
  "/casey/just",
  "/go-task",
  "/NixOS",
  "/Homebrew",
  "/containers",
  "/helm",
  "/argoproj",
  "/prometheus",
  "/grafana",
  "/etcd-io",
  "/redis",
  "/postgres",
  "/sqlite",
  "/ClickHouse",
  "/elastic",
  "/prisma",
  "/drizzle-team",
  "/supabase",
  "/evanw",
  "/swc-project",
  "/biomejs",
  "/oxc-project",
  "/vitejs",
  "/webpack",
  "/rollup",
  "/esbuild",
  "/tailwindlabs",
  "/remix-run",
  "/tanstack",
  "/trpc",
  "/expressjs",
  "/fastify",
  "/nestjs",
  "/honojs",
  "/tokio-rs",
  "/serde-rs",
  "/clap-rs",
  "/bytecodealliance",
  "/WebAssembly",
  "/llvm",
  "/bazelbuild",
  "/yarnpkg",
  "/eslint",
  "/prettier",
  "/babel",
  "/facebook/docusaurus",
  "/tiangolo",
  "/encode",
  "/pallets",
  "/django",
  "/pytest-dev",
  "/psf",
  "/numpy",
  "/pandas-dev",
  "/scikit-learn",
  "/pytorch",
  "/tensorflow",
  "/huggingface",
  "/jupyter",
  "/getsentry",
  "/opentelemetry",
  "/grpc",
  "/protocolbuffers",
  "/bufbuild",
  "/graphql",
  "/apollographql",
  "/ansible",
  "/pulumi",
  "/istio",
  "/envoyproxy",
  "/caddyserver",
  "/traefik",
  "/certbot",
  "/cloudflare",
  "/aws",
  "/google",
  "/azure",
] as const;

/** Catalog-style host needles (subdomains match). Path needles keep the slash. */
export const TOOL_DOC_HOSTS = [
  "docs.python.org",
  "nodejs.org",
  "doc.rust-lang.org",
  "rust-lang.org",
  "go.dev",
  "bun.sh",
  "docs.deno.com",
  "deno.com",
  "deno.land",
  "kubernetes.io",
  "docs.docker.com",
  "git-scm.com",
  "developer.mozilla.org",
  "docs.github.com",
  "docs.rs",
  "docs.npmjs.com",
  "typescriptlang.org",
  "react.dev",
  "nextjs.org",
  "pypa.io",
  "jqlang.github.io",
] as const;

/** Programming/how-to subs. Not r/all, not meme dumps. */
export const REDDIT_TALK_SUBS = [
  "programming",
  "commandline",
  "rust",
  "python",
  "golang",
  "node",
  "typescript",
  "javascript",
  "webdev",
  "devops",
  "linux",
  "neovim",
  "vim",
  "emacs",
  "docker",
  "kubernetes",
  "bash",
  "zsh",
  "sysadmin",
  "learnprogramming",
  "askprogramming",
  "experienceddevs",
  "cscareerquestions",
  "postgresql",
  "sqlite",
  "aws",
  "selfhosted",
  "learnpython",
  "cpp",
  "csharp",
  "java",
  "kotlin",
  "swift",
  "php",
  "ruby",
  "elixir",
  "haskell",
  "clojure",
  "dartlang",
  "flutter",
  "reactjs",
  "nextjs",
  "vuejs",
  "angular",
  "sveltejs",
  "django",
  "flask",
  "rails",
  "laravel",
  "androiddev",
  "iOSProgramming",
  "unix",
  "archlinux",
  "fedora",
  "debian",
  "ubuntu",
  "NixOS",
  "homelab",
  "networking",
  "netsec",
  "databases",
  "dataengineering",
  "sre",
  "terraform",
  "ansible",
  "azure",
  "googlecloud",
  "git",
  "github",
  "vscode",
  "coreutils",
  "PowerShell",
  "MachineLearning",
  "LocalLLaMA",
  "LLMDevs",
  "LangChain",
  "OpenAI",
  "ClaudeAI",
] as const;

export const GITHUB_HOST_NEEDLES = [
  ...GITHUB_TOOL_PREFIXES.map((p) => `github.com${p}`),
  ...GITHUB_TOOL_PREFIXES.map((p) => `raw.githubusercontent.com${p}`),
] as const;

/** Live seeds: docs + GitHub talk indexes + Reddit/SO how-to surfaces. */
export const TOOL_SEED_URLS = [
  "https://github.com/oven-sh/bun",
  "https://github.com/denoland/deno",
  "https://github.com/rust-lang/rust",
  "https://github.com/golang/go",
  "https://github.com/python/cpython",
  "https://github.com/nodejs/node",
  "https://github.com/git/git",
  "https://github.com/kubernetes/kubernetes",
  "https://github.com/facebook/react",
  "https://github.com/vercel/next.js",
  "https://github.com/microsoft/TypeScript",
  "https://github.com/cli/cli",
  "https://github.com/moby/moby",
  "https://github.com/jqlang/jq",
  "https://github.com/BurntSushi/ripgrep",
  "https://github.com/oven-sh/bun/issues",
  "https://github.com/jqlang/jq/issues",
  "https://github.com/BurntSushi/ripgrep/issues",
  "https://github.com/neovim/neovim/issues",
  "https://github.com/astral-sh/uv/issues",
  "https://github.com/hashicorp/terraform/issues",
  "https://raw.githubusercontent.com/oven-sh/bun/main/README.md",
  "https://raw.githubusercontent.com/denoland/deno/main/README.md",
  "https://raw.githubusercontent.com/rust-lang/rust/master/README.md",
  "https://docs.python.org/3/",
  "https://nodejs.org/api/",
  "https://doc.rust-lang.org/book/",
  "https://go.dev/doc/",
  "https://bun.sh/docs",
  "https://docs.deno.com/",
  "https://kubernetes.io/docs/home/",
  "https://git-scm.com/doc",
  "https://developer.mozilla.org/en-US/docs/Web",
  "https://docs.github.com/en/get-started",
  "https://www.typescriptlang.org/docs/",
  "https://react.dev/learn",
  "https://nextjs.org/docs",
  "https://docs.docker.com/get-started/overview/",
  "https://pip.pypa.io/en/stable/",
  "https://docs.npmjs.com/",
  "https://jqlang.github.io/jq/",
] as const;

export const TALK_SEED_URLS = [
  "https://old.reddit.com/r/programming/",
  "https://old.reddit.com/r/commandline/",
  "https://old.reddit.com/r/rust/",
  "https://old.reddit.com/r/python/",
  "https://old.reddit.com/r/golang/",
  "https://old.reddit.com/r/node/",
  "https://old.reddit.com/r/typescript/",
  "https://old.reddit.com/r/devops/",
  "https://old.reddit.com/r/linux/",
  "https://old.reddit.com/r/bash/",
  "https://old.reddit.com/r/neovim/",
  "https://old.reddit.com/r/git/",
  "https://old.reddit.com/r/docker/",
  "https://old.reddit.com/r/kubernetes/",
  "https://old.reddit.com/r/learnprogramming/",
  "https://stackoverflow.com/questions/tagged/jq",
  "https://stackoverflow.com/questions/tagged/ripgrep",
  "https://stackoverflow.com/questions/tagged/bash+json",
  "https://stackoverflow.com/questions/tagged/git",
  "https://stackoverflow.com/questions/tagged/docker",
  "https://stackoverflow.com/questions/tagged/kubernetes",
  "https://unix.stackexchange.com/questions/tagged/jq",
  "https://unix.stackexchange.com/questions/tagged/bash",
  "https://superuser.com/questions/tagged/command-line",
  "https://serverfault.com/questions/tagged/linux",
  "https://news.ycombinator.com/ask",
  "https://news.ycombinator.com/show",
  "https://lobste.rs/t/programming",
  "https://users.rust-lang.org/c/help",
  "https://discuss.python.org/c/users/7",
  "https://discourse.nixos.org/c/learn/9",
  "https://dev.to/t/python",
  "https://dev.to/t/javascript",
  "https://dev.to/t/rust",
] as const;

/** Discourse / forum hosts where people post how-tos. Topic paths only. */
export const DISCOURSE_TALK_HOSTS = [
  "users.rust-lang.org",
  "internals.rust-lang.org",
  "discuss.python.org",
  "discourse.nixos.org",
  "discuss.hashicorp.com",
  "discuss.kubernetes.io",
  "discuss.pytorch.org",
  "forums.docker.com",
  "community.grafana.com",
  "discuss.elastic.co",
  "elixirforum.com",
  "users.scala-lang.org",
  "discourse.haskell.org",
  "forums.swift.org",
  "discuss.kotlinlang.org",
] as const;

/** GitHub chrome: not problem/solution threads. */
const GITHUB_CHROME =
  /\/(?:pulls?|commit|commits|actions|security|pulse|projects?|settings|network|graphs|tree|blob|archive|releases|forks|stargazers|watchers|branches|tags|contributors|compare|blame|raw|search)(?:\/|$)/i;

const GITHUB_TALK = /\/(?:issues|discussions)(?:\/\d+)?(?:\/|$)/i;

const REDDIT_SUB_SET = new Set(REDDIT_TALK_SUBS.map((s) => s.toLowerCase()));

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function githubHost(host: string): boolean {
  return host === "github.com" || host === "raw.githubusercontent.com" || host === "gist.github.com";
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  const p = path.toLowerCase();
  const pre = prefix.toLowerCase();
  return p === pre || p.startsWith(`${pre}/`);
}

function allowlistedGithubPath(path: string): boolean {
  return GITHUB_TOOL_PREFIXES.some((p) => pathMatchesPrefix(path, p));
}

export function githubChromeUrl(url: string): boolean {
  const host = hostOf(url);
  if (host === "gist.github.com") return true;
  if (host !== "github.com" && host !== "raw.githubusercontent.com") return false;
  const path = pathOf(url);
  if (GITHUB_CHROME.test(path)) return true;
  if (host === "github.com") {
    const segs = path.split("/").filter(Boolean);
    if (segs.length < 2) return true;
  }
  return false;
}

/** @deprecated chrome-only; talk threads are not noise. */
export function githubNoiseUrl(url: string): boolean {
  if (githubTalkUrl(url)) return false;
  return githubChromeUrl(url);
}

export function githubTalkUrl(url: string): boolean {
  const host = hostOf(url);
  if (host !== "github.com") return false;
  const path = pathOf(url);
  if (!GITHUB_TALK.test(path)) return false;
  return allowlistedGithubPath(path);
}

export function githubToolUrl(url: string): boolean {
  const host = hostOf(url);
  if (host !== "github.com" && host !== "raw.githubusercontent.com") return false;
  if (githubTalkUrl(url) || githubChromeUrl(url)) return false;
  const path = pathOf(url);
  return allowlistedGithubPath(path);
}

export function toolDocsUrl(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (githubToolUrl(url)) return true;
  for (const n of TOOL_DOC_HOSTS) {
    if (host === n || host.endsWith(`.${n}`)) return true;
  }
  return false;
}

export function redditTalkUrl(url: string): boolean {
  const host = hostOf(url);
  if (host !== "reddit.com" && host !== "old.reddit.com" && host !== "np.reddit.com") return false;
  const path = pathOf(url).toLowerCase();
  const m = path.match(/^\/r\/([a-z0-9_]+)(?:\/|$)/i);
  if (!m) return false;
  return REDDIT_SUB_SET.has(m[1]!.toLowerCase());
}

export function stackTalkUrl(url: string): boolean {
  const host = hostOf(url);
  if (
    host !== "stackoverflow.com" &&
    host !== "unix.stackexchange.com" &&
    host !== "superuser.com" &&
    host !== "serverfault.com" &&
    host !== "askubuntu.com"
  ) {
    return false;
  }
  const path = pathOf(url).toLowerCase();
  return /^\/questions\/(?:tagged\/|ask$|\d+)/.test(path);
}

export function hnTalkUrl(url: string): boolean {
  const host = hostOf(url);
  if (host !== "news.ycombinator.com") return false;
  const path = pathOf(url).toLowerCase();
  return path === "/item" || path === "/ask" || path === "/show" || path === "/newest";
}

const DISCOURSE_HOST_SET = new Set<string>(DISCOURSE_TALK_HOSTS);

export function discourseTalkUrl(url: string): boolean {
  const host = hostOf(url);
  if (!DISCOURSE_HOST_SET.has(host)) return false;
  const path = pathOf(url).toLowerCase();
  return path === "/" || /^\/(?:t|c|latest|top|tags)(?:\/|$)/.test(path);
}

export function lobstersTalkUrl(url: string): boolean {
  const host = hostOf(url);
  if (host !== "lobste.rs") return false;
  const path = pathOf(url).toLowerCase();
  return path === "/" || /^\/(?:s|t|newest|active|comments)(?:\/|$)/.test(path);
}

const DEVTO_TAGS = new Set([
  "python",
  "javascript",
  "typescript",
  "rust",
  "go",
  "linux",
  "docker",
  "kubernetes",
  "git",
  "bash",
  "devops",
  "webdev",
  "node",
  "react",
]);

export function devtoTalkUrl(url: string): boolean {
  const host = hostOf(url);
  if (host !== "dev.to") return false;
  const path = pathOf(url).toLowerCase();
  if (/^\/(?:enter|search|settings|notifications|connect|code-of-conduct|privacy|terms)(?:\/|$)/.test(path)) {
    return false;
  }
  const tag = path.match(/^\/t\/([a-z0-9-]+)(?:\/|$)/);
  if (tag) return DEVTO_TAGS.has(tag[1]!);
  const segs = path.split("/").filter(Boolean);
  return segs.length >= 2;
}

/** Problem/solution surfaces: GitHub issues, Reddit, SO, HN, Discourse, Dev.to. */
export function talkUrl(url: string): boolean {
  return (
    githubTalkUrl(url) ||
    redditTalkUrl(url) ||
    stackTalkUrl(url) ||
    hnTalkUrl(url) ||
    discourseTalkUrl(url) ||
    lobstersTalkUrl(url) ||
    devtoTalkUrl(url)
  );
}

/** Random GitHub stays off. Allowlisted repos + their issues/discussions stay. */
export function githubFrontierJunk(url: string): boolean {
  const host = hostOf(url);
  if (!githubHost(host)) return false;
  if (githubTalkUrl(url)) return false;
  if (githubChromeUrl(url)) return true;
  return !githubToolUrl(url);
}

/** Other talk hosts: keep allowlisted threads, drop profiles/ads. */
export function talkFrontierJunk(url: string): boolean {
  const host = hostOf(url);
  if (host === "reddit.com" || host === "old.reddit.com" || host === "np.reddit.com") {
    return !redditTalkUrl(url);
  }
  if (
    host === "stackoverflow.com" ||
    host === "unix.stackexchange.com" ||
    host === "superuser.com" ||
    host === "serverfault.com" ||
    host === "askubuntu.com"
  ) {
    return !stackTalkUrl(url);
  }
  if (host === "news.ycombinator.com") return !hnTalkUrl(url);
  if (DISCOURSE_HOST_SET.has(host)) return !discourseTalkUrl(url);
  if (host === "lobste.rs") return !lobstersTalkUrl(url);
  if (host === "dev.to") return !devtoTalkUrl(url);
  return false;
}
