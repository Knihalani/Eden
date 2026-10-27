# StreamBench sleep compiler spec (family F11: LLM write path at sleep, with need predicates)

For the sleep-compiler subagent. It is a **different model from the stream authors** (BRIEF §4.9): authors ran on the session's default model, and the sleep compiler runs with a `model` override, recorded in its output.

You play Eden's offline sleep step. After each session ends, you read that session's raw transcript, plus the memory store as it stands, and you update the store. No model runs at hook time. The hot path only matches what you compile here, so your output must say **when** each memory will be needed, not only what it says.

## Input

`sleep/<world>/in/<batch>.json`: your sessions in time order. Each holds its timestamp and its events (`human`, `assistant`, `tool` with input and output, `notification`, `peer`, `trigger`, `compact`), with no labels. Before them comes the store compiled so far (`store_before`): memory rows with ids.

## Output

`sleep/<world>/out/<batch>.json`:

```json
{"batch": "...", "compiler": "<model id>", "sessions": [
  {"id": "code-s030", "ops": [
    {"op": "add", "id": "m0412", "text": "Package manager is pnpm 9; npm and yarn are not used in acme-platform.",
     "kind": "fact|preference|rule|plan|person|routine|procedure|episode",
     "entities": ["pnpm", "acme-platform"],
     "when": {"entities": ["pnpm", "npm", "yarn", "dependency", "lockfile"],
              "activities": ["install", "add dependency", "upgrade", "ci setup"],
              "times": []},
     "valid_until": null},
    {"op": "supersede", "old": "m0007", "new": "m0412"},
    {"op": "drop", "id": "m0100", "why": "plan happened"}
  ]}
]}
```

- **What to store.** Only what a careful assistant would want again in a *later* session: facts about the user, their world, project or people; preferences; standing instructions and rules; plans with dates; decisions and their reasons; useful gotchas.
- **What not to store.**
  - The user's one-off requests ("fix the test").
  - Tool output that is not a durable fact.
  - Chit-chat, and general knowledge.
  - What the agent did, unless it established a durable fact.
- **Text.** One self-contained atomic memory per row: name the entity, never "he" or "it". Keep the specific values (names, numbers, versions, dates).
- **`when`.** The cues that should bring the memory up, including those the user will never say:
  - `entities`: names, places, tools and packages whose mention makes it relevant. Include synonyms and the entity's category words ("Sam" → "partner", "dinner guest").
  - `activities`: tasks it bears on ("book a restaurant", "add a dependency", "email Tom", "plan the weekend").
  - `times`: dates or recurring times when it should surface unasked ("2026-10-28", "Sundays 09:00").
- **Corrections.** A newer statement that changes a stored fact: `add` the new row, then `supersede` the old one. A dated plan whose date has passed: `drop`.
- Do not use anything outside your input. Never invent facts.
