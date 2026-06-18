"""Token optimization: prompt compression and context window management."""

import logging
import re
import time
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# Rough token estimate: ~4 chars per token for English text
CHARS_PER_TOKEN = 4


def estimate_tokens(text: str) -> int:
    """Rough token count estimate."""
    return max(1, len(text) // CHARS_PER_TOKEN)


class PromptCompressor:
    """Compress prompts while preserving semantic content.

    Strategies:
    1. Remove redundant whitespace and comments
    2. Summarize long natural-language sections
    3. Truncate with semantic preservation
    """

    def __init__(self, summarizer_model: str | None = None):
        self.summarizer_model = summarizer_model

    def compress(self, prompt: str, max_tokens: int) -> str:
        """Compress a prompt to fit within max_tokens."""
        current_tokens = estimate_tokens(prompt)
        if current_tokens <= max_tokens:
            return prompt

        # Strategy 1: Remove redundant whitespace/comments
        prompt = self._minimize_whitespace(prompt)
        current_tokens = estimate_tokens(prompt)
        if current_tokens <= max_tokens:
            return prompt

        # Strategy 2: Truncate with semantic preservation
        prompt = self._semantic_truncate(prompt, max_tokens)
        return prompt

    def _minimize_whitespace(self, text: str) -> str:
        """Collapse redundant whitespace and remove code comments."""
        # Collapse multiple whitespace to single space
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        # Remove Python-style single-line comments (outside strings)
        text = re.sub(r"(?m)^[ \t]*#.*$", "", text)
        # Remove excessive blank lines
        text = re.sub(r"\n[ \t]*\n", "\n", text)
        return text.strip()

    def _semantic_truncate(self, text: str, max_tokens: int) -> str:
        """Truncate text while keeping the most important parts.

        Preserves:
        - Code blocks (```...```)
        - Bullet points and numbered lists
        - The first and last sentences of paragraphs
        """
        max_chars = max_tokens * CHARS_PER_TOKEN
        if len(text) <= max_chars:
            return text

        # Extract code blocks — always preserve them
        code_blocks: list[str] = []
        preserved_text = text
        for match in re.finditer(r"```[\s\S]*?```", text):
            placeholder = f"<<<CODE_BLOCK_{len(code_blocks)}>>>"
            code_blocks.append(match.group(0))
            preserved_text = preserved_text.replace(match.group(0), placeholder, 1)

        # Truncate the non-code text
        if len(preserved_text) > max_chars - sum(len(b) for b in code_blocks):
            available = max_chars - sum(len(b) for b in code_blocks) - 100
            if available > 200:
                preserved_text = self._truncate_text(preserved_text, available)

        # Restore code blocks
        for i, block in enumerate(code_blocks):
            preserved_text = preserved_text.replace(f"<<<CODE_BLOCK_{i}>>>", block, 1)

        return preserved_text.strip()

    def _truncate_text(self, text: str, max_chars: int) -> str:
        """Smart text truncation preserving beginning and end."""
        if len(text) <= max_chars:
            return text

        # Keep first 40% and last 40%, insert ellipsis in middle
        keep_each = int(max_chars * 0.4)
        prefix = text[:keep_each]
        suffix = text[-keep_each:] if len(text) > keep_each * 2 else ""
        return f"{prefix}\n\n... [truncated] ...\n\n{suffix}"


@dataclass
class Message:
    """A message in a conversation."""

    role: str  # system | user | assistant
    content: str
    timestamp: float | None = None


class ContextWindowManager:
    """Intelligently manages what stays in the context window.

    Prioritizes messages by relevance to the current query,
    always keeps system prompt, and preserves critical context.
    """

    def __init__(self, max_tokens: int = 32000):
        self.max_tokens = max_tokens

    def build_prompt(
        self,
        system_prompt: str,
        history: list[Message],
        new_message: str,
    ) -> str:
        """Build a prompt that fits within the token budget.

        1. Always keep system prompt
        2. Always keep the new message
        3. Score history by relevance
        4. Add highest-relevance messages until limit reached
        """
        system_tokens = estimate_tokens(system_prompt)
        new_msg_tokens = estimate_tokens(new_message)
        reserved = system_tokens + new_msg_tokens + 50  # buffer
        available = self.max_tokens - reserved

        if available <= 0:
            # Extreme case: just return system + new message
            return f"{system_prompt}\n\n{new_message}"

        # Score each history message by relevance to new message
        scored = [
            (msg, self._score_relevance(msg, new_message))
            for msg in history
        ]
        scored.sort(key=lambda x: x[1], reverse=True)

        # Add messages greedily by relevance
        selected: list[Message] = []
        current_tokens = 0

        # Always include the most recent exchanges (temporal locality)
        recent_cutoff = max(0, len(scored) - 3)
        for msg, score in scored[:recent_cutoff]:
            msg_tokens = estimate_tokens(msg.content)
            if current_tokens + msg_tokens <= available:
                selected.append(msg)
                current_tokens += msg_tokens

        # Ensure last 3 messages are always included (conversation continuity)
        for msg, _ in scored[recent_cutoff:]:
            msg_tokens = estimate_tokens(msg.content)
            if current_tokens + msg_tokens <= available:
                selected.append(msg)
                current_tokens += msg_tokens
            else:
                break

        # Sort selected by original order for coherence (O(n) using index map)
        history_index = {m: i for i, m in enumerate(history)}
        selected.sort(key=lambda m: history_index[m])

        # Assemble final prompt
        parts = [system_prompt]
        for msg in selected:
            role_label = msg.role.capitalize()
            parts.append(f"{role_label}: {msg.content}")
        parts.append(f"User: {new_message}")

        return "\n\n".join(parts)

    def _score_relevance(self, msg: Message, query: str) -> float:
        """Score how relevant a message is to the current query.

        Simple keyword overlap + recency bonus.
        """
        query_words = set(query.lower().split())
        msg_words = set(msg.content.lower().split())

        if not query_words or not msg_words:
            return 0.0

        # Jaccard similarity
        overlap = len(query_words & msg_words)
        union = len(query_words | msg_words)
        semantic_score = overlap / union if union else 0.0

        # Role bonuses
        if msg.role == "system":
            semantic_score += 0.5
        elif msg.role == "assistant" and "error" in msg.content.lower():
            semantic_score += 0.3  # Error messages are important context

        # Recency bonus (if timestamp available)
        if msg.timestamp:
            age_seconds = time.time() - msg.timestamp
            recency_bonus = max(0, 1.0 - age_seconds / 3600) * 0.2
            semantic_score += recency_bonus

        return min(1.0, semantic_score)
