# StreamBench personal world bible (R10)

The user, cast and places are LifeBench's: read `benchmarks/memory-life/WORLD.md` first (Riya Malhotra, Toronto, her family, her work at Lumen Pay). Two things differ from it:

1. **Time.** There is no single "now". The stream runs **2025-04-01 → 2026-10-25**, and every session has its own timestamp (America/Toronto). Write each session as happening at that moment. Use dates consistent with it: "next Friday" means the Friday after the session's date. An item's facts are true from the session that first states them.
2. **The host.** Riya uses one general agent through a chat app on her laptop and phone, for everything: assistant, proactive helper, coworker, Spanish tutor, sometimes a sounding board. The agent acts through tools. They are shown as shell commands of a fictional assistant toolbox. Use these and similar:

| Command | Does |
|---|---|
| `cal list --from 2026-10-19 --to 2026-10-25`, `cal add "…" --at … --with …`, `cal move …` | calendar |
| `mail search "…"`, `mail read <id>`, `mail draft --to … --subject …`, `mail send <draft-id>` | email (Gmail) |
| `msg read --from Sam`, `msg send --to Hannah "…"` | text messages |
| `contacts show "Priya Nair"` | contacts |
| `web search "…"`, `web open <url>` | the web |
| `book table --place … --at … --party 4`, `book flight …`, `shop order …`, `pay etransfer --to … --amount …` | actions with consequences |
| `notes show "kitchen reno"`, `notes add …`, `docs open "Payouts v2 PRD"`, `linear list --assignee riya` | notes, work docs, tickets |
| `weather --city Ottawa`, `maps route --to …` | lookups |

Output looks like real tool output: listings, JSON-ish records, email bodies, search snippets.

**Non-human events.**
- Background tasks the agent ran finish and report back (task notifications).
- Other agents message the main agent (peer messages): `inbox-agent` (email triage), `finance-agent` (bills, budget), `calendar-agent` (scheduling conflicts), `school-portal` (Morse Street PS notices), `work-agent` (Linear/Slack digests).
- **Triggers** wake the agent with no prompt from Riya. These are a scheduled time ("[Scheduled 07:00] Morning check-in"), a calendar alarm ("[Calendar] 'Lunch with Priya' starts in 60 min — Bar Isabel"), or an incoming message ("[Message from Hannah] are we still on for Saturday?").
