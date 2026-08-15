"""F35 — Default signal library templates + org seed.

Seeds plain-English NL signals (Phase Q storage) so new orgs start
with a useful detector set. LLM-investigator schemas from the F35
spec are recorded on the template for future F06 wiring; seeding
today goes through ``compile_signal`` into ``nl_signals``.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SignalTemplate:
    id: str
    name: str
    description: str
    output_schema: dict[str, Any]
    investigator_prompt: str | None = None
    statgate_rule: str | None = None
    default_enabled: bool = True


@dataclass
class SeedResult:
    count: int
    skipped: int = 0
    profile: str = "standard"
    signal_ids: list[str] | None = None


DEFAULT_SIGNALS: list[SignalTemplate] = [
    SignalTemplate(
        id="forgetting",
        name="Forgetting",
        description="Agent ignores earlier context or contradicts prior turns in the last 24 hours",
        output_schema={"forgot": "bool", "step": "int"},
        investigator_prompt="Detect when the agent forgot earlier conversation context.",
    ),
    SignalTemplate(
        id="laziness",
        name="Laziness",
        description="Agent skips required tool use or under-calls tools in the last 24 hours",
        output_schema={"lazy": "bool", "skipped_tool": "str"},
        investigator_prompt="Detect when the agent should have used a tool but did not.",
    ),
    SignalTemplate(
        id="win",
        name="Wins",
        description="Task completed exceptionally well with high user satisfaction in the last 24 hours",
        output_schema={"win": "bool", "reason": "str"},
        investigator_prompt="Detect exceptional successful outcomes worth reinforcing.",
    ),
    SignalTemplate(
        id="jailbreak_attempt",
        name="Jailbreak attempt",
        description="User tries policy bypass or jailbreak phrasing in the last 24 hours",
        output_schema={"attempt": "bool", "quote": "str"},
        investigator_prompt="Detect jailbreak / policy-bypass attempts in user input.",
    ),
    SignalTemplate(
        id="user_frustration",
        name="User frustration",
        description="User frustration or repeated regeneration requests in the last 24 hours",
        output_schema={"frustrated": "bool"},
        investigator_prompt="Detect negative sentiment and regen loops from the user.",
    ),
    SignalTemplate(
        id="hallucination",
        name="Hallucination",
        description="Agent claims facts without tool evidence in the last 24 hours",
        output_schema={"hallucinated": "bool"},
        investigator_prompt="Detect unsupported factual claims without tool grounding.",
    ),
    SignalTemplate(
        id="looping",
        name="Looping",
        description="Repetitive tool call or message loop rate above 5% in the last 24 hours",
        output_schema={"loop": "bool"},
        statgate_rule="tool_call_rate > 0.05",
        investigator_prompt=None,
    ),
    SignalTemplate(
        id="cost_spike",
        name="Cost spike",
        description="Cost per call spike above 3 standard deviations in the last 24 hours",
        output_schema={"spike": "bool"},
        statgate_rule="cost_per_call > 3sigma",
        investigator_prompt=None,
    ),
]

PROFILE_SIGNALS: dict[str, list[str]] = {
    "minimal": ["looping", "cost_spike"],
    "standard": [
        "forgetting",
        "laziness",
        "user_frustration",
        "hallucination",
        "looping",
        "cost_spike",
    ],
    "advanced": [t.id for t in DEFAULT_SIGNALS],
}

_BY_ID: dict[str, SignalTemplate] = {t.id: t for t in DEFAULT_SIGNALS}


def templates_for_profile(profile: str = "standard") -> list[SignalTemplate]:
    ids = PROFILE_SIGNALS.get(profile) or PROFILE_SIGNALS["standard"]
    return [_BY_ID[i] for i in ids if i in _BY_ID]


async def seed_org_signals(
    org_id: str,
    profile: str = "standard",
    *,
    created_by: str | None = None,
    pg: Any | None = None,
) -> SeedResult:
    """Insert missing default NL signals for an org.

    Idempotent: skips templates whose description (or cluster signature)
    already exists for the org. Missing ``nl_signals`` relation returns
    ``SeedResult(count=0)`` without raising.
    """
    from eden.services.cat2_intel.signals import compile_signal, signal_signature

    if pg is None:
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()

    templates = templates_for_profile(profile)
    created = 0
    skipped = 0
    ids: list[str] = []

    try:
        existing = await pg.fetch(
            """
            SELECT description, cluster_id
            FROM nl_signals
            WHERE org_id = $1
            """,
            org_id,
        )
    except Exception as exc:
        logger.info(
            "seed_org_signals: nl_signals unavailable org=%s: %s",
            org_id,
            exc,
        )
        return SeedResult(count=0, skipped=len(templates), profile=profile, signal_ids=[])

    existing_desc = {str(r["description"] or "") for r in existing}
    existing_cluster = {str(r["cluster_id"] or "") for r in existing if r.get("cluster_id")}

    for tmpl in templates:
        cluster_id = signal_signature(tmpl.description)
        if tmpl.description in existing_desc or cluster_id in existing_cluster:
            skipped += 1
            continue
        rule = compile_signal(tmpl.description)
        signal_id = str(uuid.uuid4())
        import json

        try:
            await pg.execute(
                """
                INSERT INTO nl_signals
                    (id, org_id, description, rule, enabled,
                     created_by, cluster_id)
                VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
                """,
                signal_id,
                org_id,
                tmpl.description,
                json.dumps(rule.to_dict(), default=str, separators=(",", ":")),
                tmpl.default_enabled,
                created_by,
                cluster_id,
            )
        except Exception as exc:
            logger.warning(
                "seed_org_signals: insert failed org=%s tmpl=%s: %s",
                org_id,
                tmpl.id,
                exc,
            )
            skipped += 1
            continue
        created += 1
        ids.append(signal_id)
        existing_desc.add(tmpl.description)
        existing_cluster.add(cluster_id)

    # F35 bridge: also upsert into ``signal_definitions`` so the F06
    # per-trace investigator (which reads ``signal_definitions``) sees the
    # library. Idempotent on (org_id, template_id). Best-effort.
    await upsert_signal_definitions(org_id, templates, pg=pg)

    return SeedResult(
        count=created,
        skipped=skipped,
        profile=profile,
        signal_ids=ids,
    )


async def upsert_signal_definitions(
    org_id: str,
    templates: list[SignalTemplate],
    *,
    pg: Any | None = None,
    enabled_override: bool | None = None,
) -> int:
    """Upsert default-library templates into ``signal_definitions``.

    Keyed on the partial-unique ``(org_id, template_id)`` index (migration
    097). Returns the number of rows upserted. Never raises — a missing
    relation or column just logs and returns 0.
    """
    import json

    if pg is None:
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
    if pg is None:
        return 0

    upserted = 0
    for tmpl in templates:
        enabled = (
            enabled_override
            if enabled_override is not None
            else tmpl.default_enabled
        )
        try:
            await pg.execute(
                """
                INSERT INTO signal_definitions
                    (org_id, name, description, output_schema, enabled,
                     template_id, statgate_rule, investigator_prompt)
                VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
                ON CONFLICT (org_id, template_id)
                    WHERE template_id IS NOT NULL
                DO UPDATE SET
                    name = EXCLUDED.name,
                    description = EXCLUDED.description,
                    output_schema = EXCLUDED.output_schema,
                    statgate_rule = EXCLUDED.statgate_rule,
                    investigator_prompt = EXCLUDED.investigator_prompt
                """,
                org_id,
                tmpl.name,
                tmpl.description,
                json.dumps(tmpl.output_schema, default=str),
                enabled,
                tmpl.id,
                tmpl.statgate_rule,
                tmpl.investigator_prompt,
            )
            upserted += 1
        except Exception as exc:
            logger.info(
                "upsert_signal_definitions: skip org=%s tmpl=%s: %s",
                org_id,
                tmpl.id,
                exc,
            )
    return upserted
