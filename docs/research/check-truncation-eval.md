# Check-truncation free eval

`bun run eval`, no API key, $0. Main: `6c35058e6`; fix: `bdcf5c7d9`.
Both runs use their own workspace engine. Outcome metrics match; latency is unpaired wall-clock noise.
The default eval explicitly leaves `pushCheck` inert: this is a regression screen, not a checker accuracy test.

## origin/main

```json
{
  "live": false,
  "waitMs": 2000,
  "planner": true,
  "inert": [
    "askReader's reading (needs a reader: pass --reader stub|oracle; the push's candidates run without one, D276)",
    "cards (needs a card maker; the eval wires none, so no card is made or matched)",
    "intent (needs the card maker's intent requests; not wired)",
    "pushCheck (needs a checker: only `--live` wires one, so no push is checked)"
  ],
  "scenarios": 32,
  "turns": 153,
  "scoredTurns": 107,
  "precision": 0.9811320754716981,
  "recall": 1,
  "falseFireRate": 0,
  "counts": {
    "expected": 52,
    "found": 52,
    "delivered": 53,
    "deliveredExpected": 52,
    "silentTurns": 69,
    "falseFires": 0
  },
  "modelCallsPerTurn": 0,
  "costPerTurnUsd": 0,
  "latencyP50Ms": 0.17434900000000653,
  "latencyP95Ms": 6.38739099999998,
  "decisions": {
    "skipped": 81,
    "reader-push": 46,
    "silent": 36,
    "sources": 25,
    "fallback": 8,
    "answer": 6,
    "fast": 1
  },
  "plannedLookups": 53,
  "byCategory": {
    "adversarial": {
      "scenarios": 6,
      "scoredTurns": 19,
      "precision": 1,
      "recall": 1,
      "falseFireRate": 0
    },
    "follow-ups": {
      "scenarios": 3,
      "scoredTurns": 9,
      "precision": 1,
      "recall": 1,
      "falseFireRate": 0
    },
    "inbox": {
      "scenarios": 5,
      "scoredTurns": 19,
      "precision": 1,
      "recall": 1,
      "falseFireRate": 0
    },
    "purchases": {
      "scenarios": 4,
      "scoredTurns": 11,
      "precision": 1,
      "recall": 1,
      "falseFireRate": 0
    },
    "relationships": {
      "scenarios": 4,
      "scoredTurns": 12,
      "precision": 1,
      "recall": 1,
      "falseFireRate": 0
    },
    "scheduling": {
      "scenarios": 6,
      "scoredTurns": 26,
      "precision": 0.9375,
      "recall": 1,
      "falseFireRate": 0
    },
    "sessions": {
      "scenarios": 1,
      "scoredTurns": 3,
      "precision": 1,
      "recall": 1,
      "falseFireRate": 0
    },
    "travel": {
      "scenarios": 3,
      "scoredTurns": 8,
      "precision": 1,
      "recall": 1,
      "falseFireRate": 0
    }
  },
  "privacy": {
    "secretsPlanted": 2,
    "secretsExposed": 4,
    "secretsLeaked": 0,
    "injections": 44,
    "notInert": 0
  },
  "ask": {
    "cases": 6,
    "answered": 6,
    "recall": 1
  },
  "acting": {
    "scenarios": 38,
    "neutralTurns": 28,
    "packetsOnNeutral": 8,
    "packetsOnNeutralRate": 0.2857142857142857,
    "itemsPerNeutralTurn": 0.5714285714285714,
    "owedTurns": 10,
    "factsOwed": 11,
    "factsHanded": 10,
    "factsHandedRate": 0.9090909090909091,
    "decoyTurns": 10,
    "decoyHanded": 3,
    "decoyHandedRate": 0.3,
    "decisions": {
      "skipped": 38,
      "reader-push": 38,
      "silent": 33,
      "sources": 5
    }
  }
}
```

## Fix branch

```json
{
  "live": false,
  "waitMs": 2000,
  "planner": true,
  "inert": [
    "askReader's reading (needs a reader: pass --reader stub|oracle; the push's candidates run without one, D276)",
    "cards (needs a card maker; the eval wires none, so no card is made or matched)",
    "intent (needs the card maker's intent requests; not wired)",
    "pushCheck (needs a checker: only `--live` wires one, so no push is checked)"
  ],
  "scenarios": 32,
  "turns": 153,
  "scoredTurns": 107,
  "precision": 0.9811320754716981,
  "recall": 1,
  "falseFireRate": 0,
  "counts": {
    "expected": 52,
    "found": 52,
    "delivered": 53,
    "deliveredExpected": 52,
    "silentTurns": 69,
    "falseFires": 0
  },
  "modelCallsPerTurn": 0,
  "costPerTurnUsd": 0,
  "latencyP50Ms": 0.15882500000000732,
  "latencyP95Ms": 7.819096000000002,
  "decisions": {
    "skipped": 81,
    "reader-push": 46,
    "silent": 36,
    "sources": 25,
    "fallback": 8,
    "answer": 6,
    "fast": 1
  },
  "plannedLookups": 53,
  "byCategory": {
    "adversarial": {
      "scenarios": 6,
      "scoredTurns": 19,
      "precision": 1,
      "recall": 1,
      "falseFireRate": 0
    },
    "follow-ups": {
      "scenarios": 3,
      "scoredTurns": 9,
      "precision": 1,
      "recall": 1,
      "falseFireRate": 0
    },
    "inbox": {
      "scenarios": 5,
      "scoredTurns": 19,
      "precision": 1,
      "recall": 1,
      "falseFireRate": 0
    },
    "purchases": {
      "scenarios": 4,
      "scoredTurns": 11,
      "precision": 1,
      "recall": 1,
      "falseFireRate": 0
    },
    "relationships": {
      "scenarios": 4,
      "scoredTurns": 12,
      "precision": 1,
      "recall": 1,
      "falseFireRate": 0
    },
    "scheduling": {
      "scenarios": 6,
      "scoredTurns": 26,
      "precision": 0.9375,
      "recall": 1,
      "falseFireRate": 0
    },
    "sessions": {
      "scenarios": 1,
      "scoredTurns": 3,
      "precision": 1,
      "recall": 1,
      "falseFireRate": 0
    },
    "travel": {
      "scenarios": 3,
      "scoredTurns": 8,
      "precision": 1,
      "recall": 1,
      "falseFireRate": 0
    }
  },
  "privacy": {
    "secretsPlanted": 2,
    "secretsExposed": 4,
    "secretsLeaked": 0,
    "injections": 44,
    "notInert": 0
  },
  "ask": {
    "cases": 6,
    "answered": 6,
    "recall": 1
  },
  "acting": {
    "scenarios": 38,
    "neutralTurns": 28,
    "packetsOnNeutral": 8,
    "packetsOnNeutralRate": 0.2857142857142857,
    "itemsPerNeutralTurn": 0.5714285714285714,
    "owedTurns": 10,
    "factsOwed": 11,
    "factsHanded": 10,
    "factsHandedRate": 0.9090909090909091,
    "decoyTurns": 10,
    "decoyHanded": 3,
    "decoyHandedRate": 0.3,
    "decisions": {
      "skipped": 38,
      "reader-push": 38,
      "silent": 33,
      "sources": 5
    }
  }
}
```
