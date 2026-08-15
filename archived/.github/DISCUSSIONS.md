# Community — configuration (Phase 6.6.5)

This file documents the live community channels Eden uses. Update
ops when any of these rotate.

## Discord

- **Server invite:** https://discord.gg/eden
- **Server ID:** *(ops: fill in after Discord server provisioned)*
- **Bot token env var:** `DISCORD_BOT_TOKEN` (server-side; not committed)
- **Channels used:**
  - `#announcements` — releases & roadmap updates
  - `#help` — user support, triaged daily
  - `#showcase` — community-contributed environments
  - `#contributors` — PRs, design discussions, RFC office hours
  - `#feedback` — auto-mirrors insight alerts from the platform

The `DiscordBotStub` in `src/eden/sdk/community_stubs.py` is wired
to this server via the `DISCORD_BOT_TOKEN` env var.

## GitHub

- **Discussions:** enabled at https://github.com/eden/platform/discussions
- **Issue templates:** `.github/ISSUE_TEMPLATE/` (already populated)
- **Pull request template:** `.github/PULL_REQUEST_TEMPLATE.md`
- **Funding:** `https://github.com/sponsors/eden`

## Blog

- **URL:** https://eden.dev/blog
- **CMS:** GitHub Pages + Markdown (see `scripts/generate_blog_post.py`)
- **Auto-publish from insight alerts:** `BlogContentStub.generate_blog_post_from_insight`

## Office hours

- **When:** Tuesdays 10:00 PT (recurring Zoom)
- **Calendar:** https://lu.ma/eden-office-hours
- **Notes:** shared to `#contributors` channel afterward
