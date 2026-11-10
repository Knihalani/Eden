# C1: should connector presets name a fetch tool? (D415)

## In plain words

Eden can check a stored item is still current by asking the source for that one item by its id (a "fetch").
Sources that can do that are swept for deletions once a week instead of once a day when the user isn't using them
(D356), which saves connector calls. Presets (one-line entries for Gmail, Google Calendar, CalDAV and Obsidian, D294)
name no fetch tool, so they never get the weekly sweep.

We looked at each preset to see whether a fetch tool can safely be added. For now none can:

- **Gmail.** A Gmail fetch returns the whole thread. The search Eden uses returns only the newest message. If Eden
  re-read an unchanged thread with a fetch, the copy would look different and the agent would be sent an "updated"
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
| `gmail` | `get_thread` | `google-tools.json`: `threadId` (required), `messageFormat` enum | No. The served descriptions (Google's hosted Gmail server, read 2026-11-10 in this session's tool list; schemas only, no mail read): `THREAD_VIEW_SUMMARY` "returns `THREAD_VIEW_MINIMAL` fields with only the most recent message per thread (`messages` has at most 1 entry), plus `messageCount` and `viewUrl`"; `get_thread` returns "a list of its messages", and its formats (`MINIMAL`, `METADATA_ONLY`, `PLAIN_TEXT`, `FULL_CONTENT`) change each message's fields, not how many. A thread row has no top-level title or text key, so `rowItem` holds its whole JSON as the text (`mcp-source.ts`), and D205's version (title and text) differs for any thread of two or more messages. |
| `google-calendar` | `get_event` | `google-tools.json`: `eventId` (required), `calendarId` (optional, primary by default) | Unknown. No reply of either tool was captured. An event's title is its `summary` and its text its `description`, or the whole JSON when there is none, so any field the two tools serialise differently would read as a change. No `listTool` (D57), so D356 does not apply to this preset at all. |
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
  listed 0 times in three active days, while the plain preset entry is listed 3 or more times. With the switch at 0
  the first count is 6 and the test fails, so the test tells the two sweeps apart.

## Next

A captured reply pair (`search_events` and `get_event` for one event, `search_threads` with the summary view and
`get_thread` for one thread), taken from a consenting test account and stored as a fixture, would settle Calendar
and show the shape needed for a Gmail mapping. Until then the presets stay on the daily sweep.
