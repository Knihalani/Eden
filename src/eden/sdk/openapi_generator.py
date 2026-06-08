"""Eden SDK — OpenAPI reference auto-generation.

Generates language-native SDK documentation and type stubs from the
live OpenAPI spec. Keeps SDK docs always in sync with the API.

References: eden-sdk-integration-architecture.md §8.3, §10.2
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class EndpointDoc:
    """Structured documentation for a single API endpoint."""

    method: str
    path: str
    summary: str
    description: str
    tags: list[str]
    request_schema: dict[str, Any] | None
    response_schema: dict[str, Any] | None
    example_request: dict[str, Any] | None
    example_response: dict[str, Any] | None
    deprecated: bool = False


@dataclass
class SDKReference:
    """Generated SDK reference bundle."""

    version: str
    generated_at: str
    endpoints: list[EndpointDoc]
    schemas: dict[str, dict[str, Any]]
    security_schemes: dict[str, dict[str, Any]]


class OpenAPIGenerator:
    """Auto-generate SDK reference documentation from an OpenAPI spec."""

    def __init__(self, spec_url: str = "http://localhost:8000/openapi.json"):
        self.spec_url = spec_url
        self._spec: dict[str, Any] | None = None

    async def fetch_spec(self) -> dict[str, Any]:
        """Fetch the OpenAPI spec from the Eden API."""
        import aiohttp

        async with aiohttp.ClientSession() as session:
            async with session.get(self.spec_url) as response:
                response.raise_for_status()
                self._spec = await response.json()
                return self._spec

    def load_spec_from_file(self, path: str | Path) -> dict[str, Any]:
        """Load an OpenAPI spec from a local JSON file."""
        with open(path, "r", encoding="utf-8") as f:
            self._spec = json.load(f)
        return self._spec

    def parse_endpoints(self) -> list[EndpointDoc]:
        """Parse all endpoints from the loaded spec."""
        if not self._spec:
            raise RuntimeError("No spec loaded. Call fetch_spec() or load_spec_from_file() first.")

        endpoints: list[EndpointDoc] = []
        paths = self._spec.get("paths", {})

        for path, methods in paths.items():
            for method, details in methods.items():
                if method in ("parameters", "servers"):
                    continue

                # Extract schemas
                req_schema = None
                if "requestBody" in details:
                    content = details["requestBody"].get("content", {})
                    json_content = content.get("application/json", {})
                    req_schema = json_content.get("schema")

                resp_schema = None
                if "responses" in details:
                    for code in ("200", "201", "202"):
                        if code in details["responses"]:
                            content = details["responses"][code].get("content", {})
                            json_content = content.get("application/json", {})
                            resp_schema = json_content.get("schema")
                            break

                endpoints.append(
                    EndpointDoc(
                        method=method.upper(),
                        path=path,
                        summary=details.get("summary", ""),
                        description=details.get("description", ""),
                        tags=details.get("tags", []),
                        request_schema=req_schema,
                        response_schema=resp_schema,
                        example_request=self._extract_example(req_schema),
                        example_response=self._extract_example(resp_schema),
                        deprecated=details.get("deprecated", False),
                    )
                )

        return endpoints

    def _extract_example(self, schema: dict[str, Any] | None) -> dict[str, Any] | None:
        """Generate a minimal valid example from a JSON schema."""
        if not schema:
            return None

        example: dict[str, Any] = {}
        if schema.get("type") == "object" and "properties" in schema:
            for prop_name, prop_schema in schema["properties"].items():
                example[prop_name] = self._mock_value(prop_schema)
        return example if example else None

    def _mock_value(self, schema: dict[str, Any]) -> Any:
        """Return a mocked value for a JSON schema fragment."""
        schema_type = schema.get("type")
        if schema_type == "string":
            fmt = schema.get("format", "")
            if fmt == "uuid":
                return "00000000-0000-0000-0000-000000000000"
            if fmt == "date-time":
                return "2026-05-29T12:00:00Z"
            if fmt == "email":
                return "user@example.com"
            if fmt == "uri":
                return "https://api.eden.ai/v1"
            enum = schema.get("enum")
            if enum:
                return enum[0]
            return f"{schema.get('description', 'string')}"
        if schema_type == "integer":
            return schema.get("minimum", 0)
        if schema_type == "number":
            return schema.get("minimum", 0.0)
        if schema_type == "boolean":
            return False
        if schema_type == "array":
            item_schema = schema.get("items", {})
            return [self._mock_value(item_schema)]
        if schema_type == "object":
            props = schema.get("properties", {})
            return {k: self._mock_value(v) for k, v in props.items()}
        if "$ref" in schema:
            return {"<ref>": schema["$ref"]}
        return None

    def generate_markdown(self, endpoints: list[EndpointDoc] | None = None) -> str:
        """Generate Markdown documentation from parsed endpoints."""
        if endpoints is None:
            endpoints = self.parse_endpoints()

        lines: list[str] = [
            "# Eden API Reference",
            "",
            f"> Auto-generated from OpenAPI spec. Version: {self._spec.get('info', {}).get('version', 'unknown')}",
            "",
            "---",
            "",
        ]

        # Group by tag
        by_tag: dict[str, list[EndpointDoc]] = {}
        for ep in endpoints:
            tag = ep.tags[0] if ep.tags else "General"
            by_tag.setdefault(tag, []).append(ep)

        for tag, eps in sorted(by_tag.items()):
            lines.append(f"## {tag}")
            lines.append("")
            for ep in eps:
                if ep.deprecated:
                    lines.append(f"### ~~`{ep.method} {ep.path}`~~ (deprecated)")
                else:
                    lines.append(f"### `{ep.method} {ep.path}`")
                lines.append(f"*{ep.summary}*")
                lines.append("")
                if ep.description:
                    lines.append(ep.description)
                    lines.append("")
                if ep.example_request:
                    lines.append("**Example request:**")
                    lines.append("```json")
                    lines.append(json.dumps(ep.example_request, indent=2))
                    lines.append("```")
                    lines.append("")
                if ep.example_response:
                    lines.append("**Example response:**")
                    lines.append("```json")
                    lines.append(json.dumps(ep.example_response, indent=2))
                    lines.append("```")
                    lines.append("")
                lines.append("")

        return "\n".join(lines)

    def generate_typescript_types(self) -> str:
        """Generate TypeScript type definitions from OpenAPI schemas."""
        if not self._spec:
            raise RuntimeError("No spec loaded.")

        schemas = self._spec.get("components", {}).get("schemas", {})
        lines: list[str] = ["// Auto-generated TypeScript types for Eden API", ""]

        for name, schema in sorted(schemas.items()):
            ts_type = self._schema_to_ts(schema, schemas)
            lines.append(f"export type {name} = {ts_type};")
            lines.append("")

        return "\n".join(lines)

    def _schema_to_ts(self, schema: dict[str, Any], defs: dict[str, Any]) -> str:
        """Convert a JSON schema fragment to a TypeScript type string."""
        if "$ref" in schema:
            ref_name = schema["$ref"].split("/")[-1]
            return ref_name

        schema_type = schema.get("type")
        if schema_type == "object":
            props = schema.get("properties", {})
            required = set(schema.get("required", []))
            fields = []
            for prop_name, prop_schema in props.items():
                is_req = prop_name in required
                ts = self._schema_to_ts(prop_schema, defs)
                fields.append(f"  {prop_name}{'' if is_req else '?'}: {ts};")
            return "{\n" + "\n".join(fields) + "\n}"

        if schema_type == "array":
            items = self._schema_to_ts(schema.get("items", {}), defs)
            return f"Array<{items}>"

        if schema_type == "string":
            enum = schema.get("enum")
            if enum:
                return " | ".join(f'"{v}"' for v in enum)
            return "string"

        if schema_type == "integer":
            return "number"
        if schema_type == "number":
            return "number"
        if schema_type == "boolean":
            return "boolean"

        # Fallback for anyOf / oneOf
        if "anyOf" in schema:
            parts = [self._schema_to_ts(s, defs) for s in schema["anyOf"]]
            return " | ".join(parts)

        return "unknown"

    def write_sdk_reference(
        self,
        output_dir: str | Path,
        endpoints: list[EndpointDoc] | None = None,
    ) -> Path:
        """Write generated SDK reference files to disk."""
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)

        if endpoints is None:
            endpoints = self.parse_endpoints()

        # Markdown docs
        md_path = out / "REFERENCE.md"
        md_path.write_text(self.generate_markdown(endpoints), encoding="utf-8")

        # TypeScript types
        ts_path = out / "types.ts"
        ts_path.write_text(self.generate_typescript_types(), encoding="utf-8")

        # JSON manifest
        manifest = {
            "version": self._spec.get("info", {}).get("version", "unknown"),
            "generated_at": "2026-05-29T00:00:00Z",
            "endpoint_count": len(endpoints),
            "tags": sorted({tag for ep in endpoints for tag in ep.tags}),
        }
        manifest_path = out / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

        logger.info("SDK reference written to %s", out)
        return out


class InlineDocGenerator:
    """Generate inline docstrings for SDK methods from OpenAPI specs."""

    @staticmethod
    def docstring_for_endpoint(endpoint: EndpointDoc) -> str:
        """Generate a Python docstring for an endpoint."""
        lines = [
            endpoint.summary or f"{endpoint.method} {endpoint.path}",
            "",
            endpoint.description or "",
            "",
            f"Endpoint: ``{endpoint.method} {endpoint.path}``",
            "",
        ]

        if endpoint.example_request:
            lines.append("Example request:")
            lines.append("```python")
            lines.append(json.dumps(endpoint.example_request, indent=2))
            lines.append("```")
            lines.append("")

        if endpoint.deprecated:
            lines.append(".. deprecated::")
            lines.append("   This endpoint is deprecated. See API docs for alternatives.")
            lines.append("")

        return "\n".join(lines)
