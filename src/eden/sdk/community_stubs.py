"""Eden SDK — Community & DevRel integration stubs.

Provides lightweight integration points for Discord bots, GitHub
discussions, and blog content generation to support the Eden
developer community.

References: eden-sdk-integration-architecture.md §12.4
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────
# Discord Integration Stub
# ──────────────────────────────────────────────────────────────────────────


@dataclass
class DiscordEmbed:
    """A Discord embed for rich notifications."""

    title: str
    description: str
    color: int = 0x00_8C_FF  # Eden blue
    fields: list[dict[str, str]] | None = None
    footer: str | None = None
    timestamp: str | None = None

    def to_dict(self) -> dict[str, Any]:
        embed: dict[str, Any] = {
            "title": self.title,
            "description": self.description,
            "color": self.color,
        }
        if self.fields:
            embed["fields"] = [
                {"name": f["name"], "value": f["value"], "inline": f.get("inline", False)}
                for f in self.fields
            ]
        if self.footer:
            embed["footer"] = {"text": self.footer}
        if self.timestamp:
            embed["timestamp"] = self.timestamp
        return embed


class DiscordBotStub:
    """Stub for an Eden Discord bot that posts job completions, insights,
    and benchmark results to a server channel.
    """

    def __init__(self, webhook_url: str | None = None):
        self.webhook_url = webhook_url

    async def post_job_completion(self, job_id: str, outcome: str, url: str) -> None:
        """Post a job completion notification to Discord."""
        if not self.webhook_url:
            logger.debug("Discord webhook not configured; skipping notification")
            return

        embed = DiscordEmbed(
            title=f"✅ Job Completed — {outcome.title()}",
            description=f"Environment generation job `{job_id}` has finished.",
            fields=[
                {"name": "Outcome", "value": outcome, "inline": True},
                {"name": "View", "value": f"[Open in Portal]({url})", "inline": True},
            ],
            footer="Eden Bot",
        )
        await self._send_embed(embed)

    async def post_benchmark_result(
        self, benchmark_id: str, score: float, previous_score: float | None
    ) -> None:
        """Post a benchmark result to Discord."""
        if not self.webhook_url:
            return

        delta = ""
        if previous_score is not None:
            change = score - previous_score
            emoji = "📈" if change > 0 else "📉" if change < 0 else "➡️"
            delta = f"{emoji} {change:+.1%} vs previous"

        embed = DiscordEmbed(
            title="📊 Benchmark Result",
            description=f"Benchmark `{benchmark_id}` finished with score **{score:.1%}**.{delta}",
            color=0x00_FF_00 if score >= 0.8 else 0xFF_A5_00,
        )
        await self._send_embed(embed)

    async def post_insight_alert(self, insight_summary: str, severity: str) -> None:
        """Post an insight detection alert to Discord."""
        if not self.webhook_url:
            return

        color = 0xFF_00_00 if severity == "high" else 0xFF_A5_00 if severity == "medium" else 0x00_8C_FF
        embed = DiscordEmbed(
            title=f"🔍 Insight Detected ({severity.upper()})",
            description=insight_summary,
            color=color,
        )
        await self._send_embed(embed)

    async def _send_embed(self, embed: DiscordEmbed) -> None:
        """Send an embed payload to the configured Discord webhook."""
        import aiohttp

        if not self.webhook_url:
            return

        payload = {"embeds": [embed.to_dict()]}
        async with aiohttp.ClientSession() as session:
            async with session.post(self.webhook_url, json=payload) as response:
                if response.status >= 400:
                    logger.warning(
                        "Discord webhook returned %s: %s",
                        response.status,
                        await response.text(),
                    )


# ──────────────────────────────────────────────────────────────────────────
# GitHub Integration Stub
# ──────────────────────────────────────────────────────────────────────────


class GitHubIntegrationStub:
    """Stub for GitHub Actions, issue templates, and discussion helpers."""

    ACTION_TEMPLATE: str = '''name: Eden Regression Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  eden-regression:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Eden CLI
        run: |
          pip install eden[cli]
          eden config set api_key "${{ secrets.EDEN_API_KEY }}"

      - name: Run benchmarks
        run: eden benchmark run ${{ vars.EDEN_BENCHMARK_ID }} --fail-on-regression

      - name: Check for new failure patterns
        run: eden insights check --since last-deployment

      - name: Upload results
        uses: actions/upload-artifact@v4
        with:
          name: eden-results
          path: ./eden-results/
'''

    ISSUE_TEMPLATE: dict[str, Any] = {
        "name": "Environment Bug Report",
        "description": "Report a bug in an Eden-generated environment",
        "labels": ["bug", "environment"],
        "body": [
            {
                "type": "input",
                "id": "environment_id",
                "attributes": {
                    "label": "Environment ID",
                    "description": "The ID of the generated environment",
                },
            },
            {
                "type": "textarea",
                "id": "description",
                "attributes": {
                    "label": "Bug Description",
                    "description": "What went wrong?",
                },
            },
            {
                "type": "textarea",
                "id": "reproduction",
                "attributes": {
                    "label": "Reproduction Steps",
                    "description": "How can we reproduce the issue?",
                },
            },
        ],
    }

    @classmethod
    def generate_action_file(cls, output_path: str) -> None:
        """Write a GitHub Actions workflow file for Eden regression testing."""
        from pathlib import Path

        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(cls.ACTION_TEMPLATE, encoding="utf-8")
        logger.info("GitHub Actions workflow written to %s", path)

    @classmethod
    def generate_issue_template(cls, output_dir: str) -> None:
        """Write GitHub issue templates for bug reports and feature requests."""
        import json
        from pathlib import Path

        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)

        (out / "environment_bug.yml").write_text(
            cls._to_yaml_form(cls.ISSUE_TEMPLATE),
            encoding="utf-8",
        )

        feature = {
            "name": "Feature Request",
            "description": "Suggest a new feature for Eden",
            "labels": ["enhancement"],
            "body": [
                {
                    "type": "textarea",
                    "id": "description",
                    "attributes": {
                        "label": "Feature Description",
                        "description": "What would you like to see?",
                    },
                },
            ],
        }
        (out / "feature_request.yml").write_text(
            cls._to_yaml_form(feature),
            encoding="utf-8",
        )

        logger.info("GitHub issue templates written to %s", out)

    @staticmethod
    def _to_yaml_form(template: dict[str, Any]) -> str:
        """Convert a dict to a minimal YAML-like string for GitHub forms."""
        import json
        # Use a simple human-readable format; in production use PyYAML
        lines = [f"name: {template['name']}", f"description: {template['description']}"]
        if template.get("labels"):
            lines.append(f"labels: [{', '.join(template['labels'])}]")
        lines.append("body:")
        for item in template["body"]:
            lines.append(f"  - type: {item['type']}")
            lines.append(f"    id: {item['id']}")
            lines.append("    attributes:")
            for k, v in item["attributes"].items():
                lines.append(f"      {k}: {v}")
        return "\n".join(lines) + "\n"


# ──────────────────────────────────────────────────────────────────────────
# Blog / Content Stub
# ──────────────────────────────────────────────────────────────────────────


class BlogContentStub:
    """Stub for auto-generating blog content and changelog entries from
    Eden pipeline events, insights, and releases.
    """

    @staticmethod
    def generate_changelog_entry(
        version: str,
        features: list[str],
        fixes: list[str],
        deprecations: list[str] | None = None,
    ) -> str:
        """Generate a Markdown changelog entry."""
        lines = [f"## {version}", ""]

        if features:
            lines.append("### Features")
            for f in features:
                lines.append(f"- {f}")
            lines.append("")

        if fixes:
            lines.append("### Bug Fixes")
            for f in fixes:
                lines.append(f"- {f}")
            lines.append("")

        if deprecations:
            lines.append("### Deprecations")
            for d in deprecations:
                lines.append(f"- {d}")
            lines.append("")

        return "\n".join(lines)

    @staticmethod
    def generate_blog_post_from_insight(
        insight_summary: str,
        affected_environments: list[str],
        recommended_action: str,
    ) -> str:
        """Draft a blog post from an auto-detected insight."""
        lines = [
            "# Insight: " + insight_summary[:60],
            "",
            "## Summary",
            insight_summary,
            "",
            "## Affected Environments",
        ]
        for env_id in affected_environments:
            lines.append(f"- `{env_id}`")
        lines.extend([
            "",
            "## Recommended Action",
            recommended_action,
            "",
            "---",
            "*This post was auto-generated by the Eden Insights Engine.*",
        ])
        return "\n".join(lines)

    @staticmethod
    def generate_release_notes(
        release_tag: str,
        benchmark_delta: dict[str, float],
        new_environments: list[str],
    ) -> str:
        """Generate release notes from pipeline metrics."""
        lines = [
            f"# Release {release_tag}",
            "",
            "## Benchmark Changes",
            "",
        ]
        for metric, delta in benchmark_delta.items():
            emoji = "📈" if delta > 0 else "📉"
            lines.append(f"- **{metric}**: {emoji} {delta:+.1%}")
        lines.extend([
            "",
            "## New Environments",
            "",
        ])
        for env_id in new_environments:
            lines.append(f"- `{env_id}`")
        lines.append("")
        return "\n".join(lines)


# ──────────────────────────────────────────────────────────────────────────
# Community Registry Stub
# ──────────────────────────────────────────────────────────────────────────


class CommunityRegistryStub:
    """Stub for a community plugin/extension registry."""

    PLUGINS: list[dict[str, Any]] = [
        {
            "name": "eden-langchain",
            "description": "LangChain callback handler for Eden tracing",
            "author": "eden-community",
            "language": "python",
            "install": "pip install eden-langchain",
        },
        {
            "name": "eden-pettingzoo",
            "description": "PettingZoo environment wrapper for Eden",
            "author": "eden-community",
            "language": "python",
            "install": "pip install eden-pettingzoo",
        },
        {
            "name": "eden-nextjs",
            "description": "Next.js integration for Eden streaming",
            "author": "eden-community",
            "language": "typescript",
            "install": "npm install @eden/nextjs",
        },
    ]

    @classmethod
    def list_plugins(cls) -> list[dict[str, Any]]:
        """Return the list of community plugins."""
        return cls.PLUGINS

    @classmethod
    def register_plugin(cls, manifest: dict[str, Any]) -> dict[str, Any]:
        """Register a new community plugin."""
        cls.PLUGINS.append(manifest)
        logger.info("Registered community plugin: %s", manifest.get("name"))
        return {"status": "registered", "plugin": manifest}
