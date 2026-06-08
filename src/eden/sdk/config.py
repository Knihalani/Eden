"""Eden SDK configuration.

Supports a hierarchical config system:
  1. Constructor arguments (highest priority)
  2. Environment variables
  3. Config file (~/.eden/config.toml or ./eden.toml)
  4. Default values (lowest priority)
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class EdenConfig:
    """Eden SDK configuration."""

    api_key: Optional[str] = None
    base_url: str = "http://localhost:8000"
    default_org: Optional[str] = None
    timeout: float = 60.0
    max_retries: int = 3
    debug: bool = False

    # Observability
    auto_trace: bool = False
    trace_sample_rate: float = 1.0

    # Sandbox defaults
    default_timeout: int = 300
    memory_limit: str = "512Mi"

    _source: str = field(default="defaults", repr=False)

    @classmethod
    def load(
        cls,
        *,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        default_org: Optional[str] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
        debug: Optional[bool] = None,
    ) -> "EdenConfig":
        """Load configuration from hierarchy.

        Priority (highest → lowest):
        1. Constructor arguments
        2. Environment variables (EDEN_API_KEY, EDEN_BASE_URL, etc.)
        3. Config file (~/.eden/config.toml or ./eden.toml)
        4. Default values
        """
        # Start with defaults
        cfg = cls()
        sources: list[str] = ["defaults"]

        # 3. Config file
        file_cfg = cls._from_file()
        if file_cfg:
            cfg = cfg._merge(file_cfg)
            sources.append("file")

        # 2. Environment variables
        env_cfg = cls._from_env()
        if env_cfg:
            cfg = cfg._merge(env_cfg)
            sources.append("env")

        # 1. Constructor arguments
        arg_cfg = cls(
            api_key=api_key,
            base_url=base_url or cfg.base_url,
            default_org=default_org or cfg.default_org,
            timeout=timeout if timeout is not None else cfg.timeout,
            max_retries=max_retries if max_retries is not None else cfg.max_retries,
            debug=debug if debug is not None else cfg.debug,
        )
        cfg = cfg._merge(arg_cfg)
        if any(v is not None for v in (api_key, base_url, default_org, timeout, max_retries, debug)):
            sources.append("args")

        cfg._source = ",".join(sources)
        return cfg

    @classmethod
    def _from_env(cls) -> Optional["EdenConfig"]:
        """Load from environment variables."""
        api_key = os.getenv("EDEN_API_KEY")
        base_url = os.getenv("EDEN_BASE_URL")
        default_org = os.getenv("EDEN_DEFAULT_ORG")
        timeout = os.getenv("EDEN_TIMEOUT")
        max_retries = os.getenv("EDEN_MAX_RETRIES")
        debug = os.getenv("EDEN_DEBUG")

        if not any((api_key, base_url, default_org, timeout, max_retries, debug)):
            return None

        return cls(
            api_key=api_key,
            base_url=base_url or "http://localhost:8000",
            default_org=default_org,
            timeout=float(timeout) if timeout else 60.0,
            max_retries=int(max_retries) if max_retries else 3,
            debug=debug.lower() in ("1", "true", "yes") if debug else False,
        )

    @classmethod
    def _from_file(cls) -> Optional["EdenConfig"]:
        """Load from config file (~/.eden/config.toml or ./eden.toml)."""
        paths = [
            Path.home() / ".eden" / "config.toml",
            Path("eden.toml"),
        ]
        for path in paths:
            if path.exists():
                return cls._parse_toml(path)
        return None

    @classmethod
    def _parse_toml(cls, path: Path) -> Optional["EdenConfig"]:
        """Parse a TOML config file."""
        try:
            import tomllib  # Python 3.11+
        except ImportError:
            try:
                import tomli as tomllib  # type: ignore
            except ImportError:
                return None

        try:
            with open(path, "rb") as f:
                data = tomllib.load(f)
        except Exception:
            return None

        return cls(
            api_key=data.get("api_key"),
            base_url=data.get("base_url", "http://localhost:8000"),
            default_org=data.get("default_org"),
            timeout=data.get("timeout", 60.0),
            max_retries=data.get("max_retries", 3),
            debug=data.get("debug", False),
        )

    def _merge(self, other: "EdenConfig") -> "EdenConfig":
        """Merge another config, taking non-None / explicitly-set values from other."""
        return EdenConfig(
            api_key=other.api_key if other.api_key is not None else self.api_key,
            base_url=other.base_url if other.base_url is not None else self.base_url,
            default_org=other.default_org if other.default_org is not None else self.default_org,
            timeout=other.timeout if other.timeout != 60.0 or self.timeout == 60.0 else self.timeout,
            max_retries=other.max_retries if other.max_retries != 3 or self.max_retries == 3 else self.max_retries,
            debug=other.debug if other.debug is not False or self.debug is False else self.debug,
        )

    def get_headers(self) -> dict[str, str]:
        """Build request headers from config."""
        headers: dict[str, str] = {}
        if self.api_key and self.default_org:
            headers["X-Org-Api-Key"] = self.api_key
            headers["X-Org-Id"] = self.default_org
        return headers
