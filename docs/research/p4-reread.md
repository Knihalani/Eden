# P4: re-reading held items from quiet sources (weak point 4, D840–D842)

Work of 2026-11-11 on weak point 4 of [weak-points-1111.md](weak-points-1111.md) ("with no change notice, a third of
owed updates never arrive") and the part of weak point 8 that needs no real data. All figures are $0 lab figures
from commands run in this session (`days-calls.ts`, the connector lab); no paid call was made and no real account
was read.

## In plain words

When a user's calendar event moves and the calendar does not tell Eden, the agent keeps the old time until Eden
happens to poll that calendar. The idea was to re-read, by id, just the few items the agent was handed from such
quiet sources, about two a request.

It does not pay. A session's agent holds about 11 such items on average (up to 69), and a re-read can only check one
at a time without knowing which one changed. Two re-reads a request cost 1.7 more connector calls a request and
recovered at most 3 of 123 owed updates. Narrowed to calendars, the only kind whose listing cannot show an edit, it
cost 0.3–0.55 calls a request for 1–3 of 6 calendar updates. Polling the source (one listing covers every held item
in it, D606) recovers an update for fewer calls: 1.7 times fewer than the re-read's best form, 3–6 times fewer than
most. So the switch is deleted (D840).

A second finding changes how big the problem is. The 67% figure is the hardest case: the lab moves an item just
before the last request of the session. With the change landing three requests after the item was handed and the
session going on, today's default delivers 90% of those updates before the session ends, most at the very next
request (D841's new `--move-after`). What stays lost is the calendar: 0 of 15 updates in every form, because a quiet
calendar is never polled within a session. Notices fix it completely (279 of 279, D606).

## 1. The baseline, re-run on today's main

`bun packages/sim/src/lab/days-calls.ts --seeds S --recap-notice none --notify-share 0.05 [--move-after N]`, default
configuration, 8 days a user, 8 users a seed set, two sets. "Owed" = an item the agent was handed that day and whose
times then moved at its source (`MovedFate` other than `unhanded`).

| Users | Move | Owed | Arrived by session end | mail | chat | calendar | documents | Request calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| seeds 41–48 | before the last request (D606's case) | 123 | 91 (74%) | 84/92 | 7/23 | 0/6 | 0/2 | 1.334 |
| seeds 49–56 | before the last request | 137 | 85 (62%) | 81/112 | 4/15 | 0/9 | 0/1 | 1.232 |
| seeds 41–48 | 3 requests after handed (`--move-after 3`) | 123 | 100 (81%) | 86/92 | 14/23 | 0/6 | 0/2 | 1.341 |
| seeds 49–56 | 3 requests after handed | 137 | 96 (70%) | 89/112 | 7/15 | 0/9 | 1/1 | 1.234 |

Over 16 users: 176 of 260 (68%) in the hardest case, 196 of 260 (75%) with mid-session moves. The items moved
mid-session alone: 63 of 69 and 53 of 60 updated by the session's end (116 of 129, 90%), a median of 0 requests
after the move and a 90th percentile of 1. With `--move-after 3`, items handed in the last three requests still move
at the recap, so the rows mix both cases. D606 read 188 of 279 on an older main; the owed set differs because the
engine has moved since (pushOpen and the earn rules change what is handed).

Why calendars are never reached: a quiet source is current while its learned rate of new items says it probably
gained nothing (`syncStaleChance`), up to `syncMaxStaleMs` (6 h); the lab's day is about three hours of Eden's
clock, and a calendar gains few items.

## 2. The trial: `heldReread` (D840, built, measured and deleted)

At each user request, behind it (no caller waits), up to N items the session's agent was handed from a source that
does not notify and can fetch by ref were re-read by id through `check`/`recheck` (D126's path: a changed copy is
stored and announced as an "updated:" packet). Oldest copy first; a copy read more recently than `heldRereadAgeMs`
was skipped. Two forms of "how old is this copy":

- **its own read time** (first build): the slots went to old mail copies, 40–50 held a session, since a mailbox poll
  lists only the newest pages;
- **the later of its own read and its source's last poll** (second build), except for a calendar (`listsByTime`),
  whose listing goes by start time and cannot show an edit. A poll of a source that lists the most recently changed
  first vouches for every copy it held.

Seeds 41–48, the second build unless said, request-time calls a request against the default's 1.334 (1.341 with
`--move-after 3`). Code in commit b095178d.

| Form | Hardest case: arrived (of 123) | Mid-session `--move-after 3` (of 123) | Calls a request |
| --- | --- | --- | --- |
| Default | 91 | 100 | 1.33 |
| own read time, N=1 / 2 / 4 | 93 / 92 / 93 | — | 2.32 / 3.30 / 5.18 |
| N=1 | 93 | 104 | 2.25 |
| N=2 | 88 | 103 | 3.05 |
| N=4 | — | 106 | 4.33 (the mid-session run's) |
| N=2, a copy at most once an hour | 92 | 104 | 2.40 |
| N=2, at most once in two hours | 91 | 101 | 1.95 |
| calendars only, N=1 | 92 | 103 | 1.89 |
| calendars only, N=2 | 93 | 103 | 2.22 |
| calendars only, N=2, once an hour | 92 | 103 | 1.77 |
| calendars only, N=2, once in two hours | 92 | 101 | 1.61 |
| `heldRereadDated` (only items whose handed copy named a time or date) | identical to the same form without it | | |

Re-reads mostly confirm: at N=2 with `--move-after 3`, 1,705 re-reads over the 8 users found 9 changed copies. Due copies a request
(N=1, seeds 41–44, 476 requests): mean 11.2, at most 69; 8.9 with the dated filter. Per recovered update (about 989
requests over the 8 users): the best form is "calendars only, N=2, once an hour" with `--move-after 3`, +0.43 calls
a request for +3 updates, about 143 calls an update; N=4 is about 490. D606's poll of held sources cost about one
call a request for every 12 of 131 updates, about 83 calls an update [EST: its ~1,000 requests, not re-run here]; the
re-read is 1.7 times dearer at best.

Why it cannot win here: a listing poll of a quiet source answers for every item held from it in one call, and the
lab's listings put an edited item first. A re-read answers for one item and cannot tell which held item changed.
It would beat a poll only where a listing cannot show an edit (a calendar listed by start time, a chat whose edits
keep their time, D345) and where few items are held from that source. The lab's simulated sources all list the most
recently changed first (`SimSource.list`), so it cannot price that case beyond the calendar row above, and the
calendar row does not pay either.

Cost-cutting tried, from the brief: re-reading only items with a date (no change: every planted item names a time),
a longer minimum age (cuts calls, loses updates in proportion). Not tried: only items the request's candidates or
answer would include, since D606 measured that targeting for polls and found nothing (the update is owed at a request
about something else, and `verifyDelivery` already re-reads a doubted copy before it is delivered); batching, since
no MCP get tool among those found takes several ids (mcpvault's `read_multiple_notes` aside, §4).

## 3. What would work, and the owner's choice

- **Notices.** Every owed update arrives (D606: 279 of 279), at one poll per notice. The paved road stays a webhook
  receiver per provider (INTEGRATION.md "Forward your sources' change notifications").
- **A poll of the held sources** (D606's curve, deleted for cost): about one more connector call a request per 12
  updates. The owner decides whether a recovered update is worth that on per-call plans.
- **Nothing at all for calendars without notices**, at today's cost: a moved meeting the agent was handed reaches it
  only at the next poll (up to 6 h, `syncMaxStaleMs`) or in the next session. Lowering `syncMaxStaleMs` for a source
  with handed items was D606's 20 and 60 min rows.

## 4. Get-by-id tools on real MCP servers (step 1)

From public documentation (not run, no account; tool names as documented, so they may change):

| Provider (server) | Search | Get by id | Notes |
| --- | --- | --- | --- |
| Gmail (Google's hosted server) | `search_threads` | `get_thread` (`threadId`), `get_message` | D415: a thread fetch holds every message, the search's summary only the newest, so a re-read reads as changed; `get_message` takes a message id the thread row does not give |
| Google Calendar (Google's hosted server) | `search_events` | `get_event` (`eventId`) | maps (D415); no reply captured, so whether its copy equals the search's is unknown |
| Notion (hosted) | `notion-search` | `notion-fetch` (`id` or `url`) | the fetch returns the whole page, the search a match; likely the Gmail problem |
| Slack (hosted, mcp.slack.com) | search messages and files | "read a thread", "read a channel" (identifiers not documented) | no single-message get; no read-only annotations documented |
| Microsoft 365 (community `ms-365-mcp-server`) | mail and calendar search | `get-mail-message` (`messageId`), `get-calendar-event` | community server; not checked |
| CalDAV (madbonez/caldav-mcp), Obsidian (bitbonsai/mcpvault) | lab servers | see §5 | run in the connector lab |

The common blocker for a preset fetch tool is not the tool's existence but the copy: a get tool returns the whole
record where a search row is a summary, and Eden's version is title and text (D205), so the first re-read of every
unchanged item would send a false "updated:" packet. Any fix (comparing only what both copies hold, or holding the
fetched copy as the item's text from the start) needs a captured reply pair per provider and is not built here.

## 5. The connector lab, end to end (weak point 8)

See §5 of this note once filled in by the lab run below.

## Reproduce

```bash
bun packages/sim/src/lab/days-calls.ts --seeds 41,42,43,44,45,46,47,48 --recap-notice none --notify-share 0.05 \
  [--move-after 3]
# the trial (commit b095178d): add --set '{"heldReread":2,"heldRereadAgeMs":3600000}'
```
