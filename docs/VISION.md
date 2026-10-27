# Vision: a context partner for agents

## The thesis

Personal and proactive agents (assistants that manage a user's mail, calendar, errands, accounts, relationships)
fail less from weak reasoning than from missing context. The facts they need sit in the user's sources: an email
from last month, a CRM note, a calendar constraint, a preference stated once. Today the agent has to know to look,
know where, and ask the right question. Usually it doesn't.

Eden is a **context partner**: a system that runs *alongside* the agent, with read access to every source the
agent's user has connected, and that does two things:

1. **Answers** the agent's questions about the user's world (`ask`), with citations.
2. **Injects** context the agent needs but did not ask for, at the moment it needs it, and otherwise stays silent.

## Why not a subagent

A subagent is called by the main model, so it inherits the main model's blind spot: the agent must already know what
context it is missing to ask for it. Proactive injection removes that dependency: the partner watches the session
and speaks first. A subagent is also generic. A dedicated partner can be optimised end to end for one job: knowing
what the user's sources hold, routing lookups, learning what helps, and saying nothing when nothing helps.

## Why it absorbs the memory category

Memory products (Supermemory, Mem0, Zep, Letta and others) are stores. To Eden, a store is one more read source
behind an MCP connector. Eden's value is the layer above every store: deciding *what* to fetch, *from where*, and
*when* to put it in front of the agent. Competing memory products become suppliers, not rivals.

## Evidence it works

Meta's *Remember When It Matters: Proactive Memory Agent for Long-Horizon Agents* (Wu et al., arXiv:2607.08716,
July 2026) runs a separate memory agent beside an unmodified action agent. The memory agent keeps a structured
memory bank and decides at intervals whether to inject a short reminder or stay silent. They report +8.3 pp pass@1
on Terminal-Bench 2.0 and +6.8 pp on τ²-Bench. Their ablations compare selective intervention against always-on
injection, passive bank exposure and plain retrieval. It is memory only, and on task benchmarks rather than personal
agents, but it is proof of concept for a selective proactive partner (notes: [RESEARCH.md](RESEARCH.md)).

## Scope

- **In:** personal and proactive agents that tenants (our customers) build and run for their end users, reading those
  users' connected sources: mail, calendar, docs, CRM, tickets, memory stores, anything with read tools.
- **Out, for now:** coding agents' read tools (file reads, grep). They are called far more often and the agent can
  already reach the source directly; the economics and latency are different. Revisit later.

## Principles

1. **Silence is the default.** An unneeded injection costs the agent tokens and attention. Precision beats recall.
2. **The model is the last resort.** Deterministic cues, a learned source map and a local index decide most turns.
   The model (GLM 5.3 Flash via OpenRouter to start) judges only what the cheap path cannot, under a hard budget.
   Cost and latency both depend on it.
3. **Read-only, always.** The partner never calls a tool that changes anything. It is enforced in code, not policy.
4. **The user's data stays the user's.** Strict per-user partitioning, content held in memory and not at rest by
   default, zero-data-retention model routing, and a subprocessor story a tenant can pass on to their users.
5. **Learn per user and per agent.** Which sources answer which situations, what this agent actually uses.
6. **Measured, not asserted.** Every threshold is tuned on the eval harness; every claim cites a run.
