# C1: should connector presets name a fetch tool? (D415)

**Update (D842, [p4-reread.md](p4-reread.md) §5):** the connector lab has since run the caldav and mcpvault
servers end to end: `caldav` now names `caldav_get_event_by_uid` (its fetched copy equals the searched one);
mcpvault keeps no fetch tool, for the reason given there. Gmail and Google Calendar below are unchanged.

## In plain words

Eden can check a stored item is still current by asking the source for that one item by its id (a "fetch").
Sources that can do that are swept for deletions once a week instead of once a day when the user isn't using them
(D356), which saves connector calls. Presets (one-line entries for Gmail, Google Calendar, CalDAV and Obsidian, D294)
name no fetch tool, so they never get the weekly sweep.

We looked at each preset to see whether a fetch tool can safely be added. For now none can:

- **Gmail.** A Gmail fetch returns the whole thread. The search Eden uses returns only the newest message, plus a
  message count the fetch lacks. If Eden re-read any unchanged thread with a fetch, the copy would look different and the agent would be sent an "updated"
  notice for nothing. That breaks the "silent by default" rule.
- **Google Calendar.** The fetch tool's arguments are known and map correctly, but nobody has captured what it
  returns. If its copy differs from the search's in any field, the same false "updated" notice follows. The preset has
  no listing either, so it is never swept and the weekly sweep would save nothing.
- **CalDAV and Obsidian.** The connector lab captured only these servers' search tools. We do not guess tool names.

So nothing changes in behaviour. Each preset now says in code why it has no fetch tool (`noFetch`), and the docs tell
an operator how to add one by hand once they have checked that their server's two copies match.

## Evidence

| Preset | Fetch tool on the server | Input schema | Can the fetched copy stand for the searched one? |
| --- | --- | --- | --- |
| `gmail` | `get_thread` | `google-tools.json`: `threadId` (required), `messageFormat` enum | No. The served descriptions (Google's hosted Gmail server's tools/list, captured 2026-11-10 in `fixtures/google-tool-descriptions.json`; tool metadata only, no mail read): `THREAD_VIEW_SUMMARY` "returns `THREAD_VIEW_MINIMAL` fields with only the most recent message per thread (`messages` has at most 1 entry), plus `messageCount` and `viewUrl`"; `get_thread` returns "a list of its messages", and its formats (`MINIMAL`, `METADATA_ONLY`, `PLAIN_TEXT`, `FULL_CONTENT`) change each message's fields, not how many. A thread row has no top-level title or text key, so `rowItem` holds its whole JSON as the text (`mcp-source.ts`), and D205's version (title and text) differs for any thread: `messageCount` is only on the search's thread, the default `FULL_CONTENT` adds bodies and attachments to each message, and a second message adds more. The thread's reply shape is inferred from these descriptions; no reply was captured. |
| `google-calendar` | `get_event` | `google-tools.json`: `eventId` (required), `calendarId` (optional; primary by default per the served description) | Unknown. No reply of either tool was captured. An event's title is its `summary` and its text its `description`, or the whole JSON when there is none, so any field the two tools serialise differently would read as a change. No `listTool` (D57), so D356 does not apply to this preset at all. |
| `caldav` | not captured | lab fixture has `caldav_search_events` only | Not checked: no schema. |
| `obsidian` | not captured | lab fixture has `search_notes` only | Not checked: no schema. |

Mapping a Gmail fetch so that it matches (keep the thread's last message, add `messageCount`) was considered and
rejected. It would rely on the reply listing its messages oldest first and on the summary message carrying exactly
the `MINIMAL` fields, and no reply was captured to confirm either. A wrong guess sends false updates on every
re-read, so the guess costs more than the daily sweep it would save.

The schema mapping was checked with the connect's own code (`schema-args`): `get_thread` maps the ref to `threadId`
and `get_event` maps it to `eventId`, never `calendarId`. So an operator's hand-added `fetchTool` needs no `args`.

## What the tests pin

`packages/server/src/connector-presets.test.ts`:

- every preset names a fetch tool or a `noFetch` reason;
- `get_thread` and `get_event` map from their served schemas to `{threadId}` and `{eventId}`;
- the source built through `UserSources` from a Gmail preset entry with the operator's own `fetchTool` has
  `fetchesById` true and fetches by id. Under a synced `ContextPartner` with `syncUnusedSweepMs` set to a week, it is
  listed exactly once a week (one two-page sweep, 2 calls, in eight active days), while the plain preset entry is
  swept daily (14 or more calls). With the switch at 0 the fetching source is swept daily as well and the test fails,
  so the test tells the two sweeps apart and also catches a source that is never swept again.
- the fixture's served descriptions still say what D415 rests on.

## Next

A captured reply pair (`search_events` and `get_event` for one event, `search_threads` with the summary view and
`get_thread` for one thread), taken from a consenting test account and stored as a fixture, would settle Calendar
and show the shape needed for a Gmail mapping. Until then the presets stay on the daily sweep.
