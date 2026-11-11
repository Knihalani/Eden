# Blind gate set 3: the writer's brief (P2, 2026-11-11)

Written by a Haiku 5.5 subagent that read no file of the repository. Its brief, as sent (abridged only where marked):

> Write a JSON file of test messages for a classifier that decides whether a message a user types to their AI
> assistant is a request to DO something (an acting request) or not. Do not read any files; write from your own
> imagination, as varied and realistic as you can (different people, ages, cultures, jobs, writing styles: terse,
> rambling, lowercase, typos, British, American, Australian, Indian English). [file path]
>
> 1. "indirect" (120): acting requests NOT phrased as a plain imperative. Include at least 25 where the request comes
>    after a first clause of context ("The boiler's making that noise again, can you book Ferguson's for Tuesday?",
>    "Mum's prescription runs out Sunday so please reorder it"), at least 25 hedges ("might be worth...", "would be
>    good if you could...", "I'll need...", "we could do with...", "probably should...", "it'd help to..."), and the
>    rest needs, plans, wishes and questions about acting. Each names concrete specifics [...], 5 to 40 words.
> 2. "log" (25) [...] 3. "chatter" (30) [...] 4. "statement" (45): statements of feeling, opinion, fact or vague
>    personal goals that are NOT requests for the assistant to act. At least 25 must begin like a request ("I need
>    to...", "I want to...", "we should...", "I have to...", "I'd love to...", "let's...") but be a personal resolution,
>    a vague someday idea, or a remark ("I need to drink more water", "we should do a road trip one of these years",
>    "I have to say that was a great talk"). 5. "question" (30): questions asking for information only.

**Not fully independent of the rule:** the two second-clause examples and the hedge phrases above were written by the
rule's author while writing the rule (v4) from set 2's misses, and set 3 repeats the two examples nearly word for
word (docs/research/p2-push-check.md §8).
