# R10 sleep compiler: what a strong model writes about a store, offline

The sleep compiler is a strong LLM run at sleep (never on a hook path). It sees **only the memory store** and a one-line description of the agent and its user, never a benchmark cue. In R10 the compiler is a Claude subagent (the session has no NIM key); the product's sleep model would be NIM gemma-4-31b class (D37), so every result that depends on compiled artifacts carries the caveat that its compiler was stronger than the product's.

Two passes per store. Output goes to `benchmarks/r10/compiled/<fixture>/`.

## Pass 1 — the user model (`user.json`)

Read the whole store. Write:

```json
{"entities": [{"name": "Sam Okafor", "type": "person", "aliases": ["Sam", "my partner", "my other half", "Sam's"], "about": "partner"}],
 "activities": [{"name": "dining out", "words": ["dinner", "restaurant", "table", "reservation", "brunch", "eat out", "takeout"]}],
 "background": ["...200 messages this user might send that need nothing from the store..."]}
```

- `entities`: every person, pet, place, organisation, project, product or thing the store names more than in passing. `aliases`: every way the user would refer to it, **including role words and pronoun-free descriptions** ("my mum", "the dog", "the kid", "my manager", "the reno", "the API"), common misspellings and short forms.
- `activities`: 40–80 kinds of situation in which this user's memories matter (tasks, events, topics), domain-appropriate (a coding store's are "add a dependency", "merge a PR", "debug a failing test"; a personal store's are "book travel", "buy a gift", "plan a meal"). `words`: 10–25 trigger words or short phrases a user or an event text would contain, including synonyms and informal words.
- `background`: 200 varied messages or event texts this user might send that need **no** memory: general knowledge, small talk, generic tasks, and ones that share words with the store but need nothing from it.

## Pass 2 — per memory (`mem-<chunk>.json`), using `user.json`'s names

```json
{"id": "a002", "entities": ["Sam Okafor"], "facet": "diet", "activities": ["dining out", "cooking", "hosting"],
 "needs": ["8 situations (user messages or event texts) in which this memory changes what a good agent does"],
 "near": ["5 situations that share its words or topic but do not need it"],
 "valid": {"from": "2026-09-14", "until": null, "recurring": null},
 "prior": "sometimes"}
```

- `needs`: varied: direct questions, tasks where it matters **without being mentioned** (proactive), event texts, terse and casual phrasings; most in words other than the memory's.
- `activities`: names from `user.json` only.
- `valid`: dates in the memory's own terms (a dated plan ends on its date; a routine is `recurring`, e.g. "weekly Wed"); null when timeless.
- `prior`: how often this memory is likely needed: `rarely`, `sometimes`, `often`. Noise rows (one-off past requests, saved tool output) are usually `rarely`.
