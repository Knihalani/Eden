"""Eden SDK — IDE integration stubs.

Provides lightweight integration points for VS Code, Cursor, and other
IDEs to offer inline documentation, autocomplete, and one-click actions.

References: eden-sdk-integration-architecture.md §7
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────
# VS Code Extension Stub
# ──────────────────────────────────────────────────────────────────────────


@dataclass
class VSCodeExtensionManifest:
    """Manifest for a VS Code extension integration."""

    name: str = "eden-vscode"
    display_name: str = "Eden"
    description: str = "Generate environments, run benchmarks, and inspect traces from VS Code."
    version: str = "0.1.0"
    publisher: str = "eden-ai"
    engines_vscode: str = "^1.85.0"
    categories: list[str] = None

    def __post_init__(self):
        if self.categories is None:
            self.categories = ["AI", "Machine Learning", "Snippets"]

    def to_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "displayName": self.display_name,
            "description": self.description,
            "version": self.version,
            "publisher": self.publisher,
            "engines": {"vscode": self.engines_vscode},
            "categories": self.categories,
            "activationEvents": [
                "onCommand:eden.generateEnvironment",
                "onCommand:eden.runBenchmark",
                "onLanguage:python",
                "onLanguage:typescript",
            ],
            "main": "./out/extension.js",
            "contributes": {
                "commands": [
                    {
                        "command": "eden.generateEnvironment",
                        "title": "Generate Environment",
                        "category": "Eden",
                        "icon": "$(sparkle)",
                    },
                    {
                        "command": "eden.runBenchmark",
                        "title": "Run Benchmark",
                        "category": "Eden",
                        "icon": "$(play)",
                    },
                    {
                        "command": "eden.viewTrace",
                        "title": "View Trace",
                        "category": "Eden",
                        "icon": "$(eye)",
                    },
                    {
                        "command": "eden.wrapWithTrace",
                        "title": "Wrap Function with @trace_agent",
                        "category": "Eden",
                        "icon": "$(debug-breakpoint-log)",
                    },
                    {
                        "command": "eden.openPortal",
                        "title": "Open Eden Portal",
                        "category": "Eden",
                        "icon": "$(globe)",
                    },
                ],
                "menus": {
                    "editor/context": [
                        {
                            "command": "eden.wrapWithTrace",
                            "group": "eden@1",
                            "when": "editorLangId == python",
                        }
                    ],
                    "explorer/context": [
                        {
                            "command": "eden.runBenchmark",
                            "group": "eden@1",
                            "when": "explorerResourceExtname == .py",
                        }
                    ],
                },
                "views": {
                    "explorer": [
                        {
                            "id": "edenEnvironments",
                            "name": "Environments",
                            "when": "eden.authenticated",
                        },
                        {
                            "id": "edenBenchmarks",
                            "name": "Benchmarks",
                            "when": "eden.authenticated",
                        },
                    ]
                },
                "configuration": {
                    "title": "Eden",
                    "properties": {
                        "eden.apiKey": {
                            "type": "string",
                            "default": "",
                            "description": "Your Eden API key",
                        },
                        "eden.baseUrl": {
                            "type": "string",
                            "default": "https://api.eden.ai/v1",
                            "description": "Eden API base URL",
                        },
                        "eden.defaultOrg": {
                            "type": "string",
                            "default": "",
                            "description": "Default organization ID",
                        },
                        "eden.autoTrace": {
                            "type": "boolean",
                            "default": True,
                            "description": "Automatically trace decorated functions",
                        },
                        "eden.traceLevel": {
                            "type": "string",
                            "enum": ["minimal", "standard", "detailed"],
                            "default": "standard",
                            "description": "Default trace detail level",
                        },
                    },
                },
                "snippets": [
                    {
                        "language": "python",
                        "path": "./snippets/python.json",
                    },
                    {
                        "language": "typescript",
                        "path": "./snippets/typescript.json",
                    },
                ],
            },
        }


class VSCodeExtensionStub:
    """Stub for generating VS Code extension boilerplate."""

    SNIPPETS_PYTHON: dict[str, Any] = {
        "Eden Environment Generation": {
            "prefix": "eden-env",
            "body": [
                "from eden import Eden",
                "",
                "async def generate_env():",
                '    eden = Eden(api_key="${1:your_api_key}")',
                "    env = await eden.environments.create(",
                '        description="${2:Description of the environment}",',
                '        framework="${3|gymnasium,custom,langchain|}",',
                '        language="${4|python,typescript|}",',
                "    )",
                "    print(env.code)",
            ],
            "description": "Generate an Eden environment",
        },
        "Eden Trace Agent": {
            "prefix": "eden-trace",
            "body": [
                "from eden import trace_agent",
                "",
                "@trace_agent(",
                '    environment_id="${1:env_id}",',
                '    tags=["${2:production}"],',
                ")",
                "async def ${3:my_agent}(${4:query}: str) -> str:",
                "    ${5:# TODO: implement agent logic}",
                "    return \"\"",
            ],
            "description": "Wrap a function with Eden trace_agent decorator",
        },
        "Eden Benchmark": {
            "prefix": "eden-bench",
            "body": [
                "from eden import Eden",
                "",
                "async def run_benchmark():",
                '    eden = Eden(api_key="${1:your_api_key}")',
                "    results = await eden.benchmarks.execute(",
                '        benchmark_id="${2:bench_id}",',
                '        agent_config={"model": "${3|gpt-4o,claude-sonnet-4|}"},',
                "    )",
                "    print(f\"Score: {results.score}\")",
            ],
            "description": "Run an Eden benchmark",
        },
    }

    SNIPPETS_TYPESCRIPT: dict[str, Any] = {
        "Eden Environment Generation": {
            "prefix": "eden-env",
            "body": [
                "import { EdenClient } from '@eden/sdk';",
                "",
                "const client = new EdenClient({",
                '  apiKey: "${1:your_api_key}",',
                "});",
                "",
                "async function generateEnv() {",
                "  const env = await client.environments.create({",
                '    description: "${2:Description}",',
                '    framework: "${3|gymnasium,custom,langchain|}",',
                "  });",
                "  console.log(env.code);",
                "}",
            ],
            "description": "Generate an Eden environment",
        },
    }

    @classmethod
    def generate_boilerplate(cls, output_dir: str | Path) -> Path:
        """Generate a VS Code extension boilerplate in the given directory."""
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)

        # package.json
        manifest = VSCodeExtensionManifest()
        (out / "package.json").write_text(
            json.dumps(manifest.to_json(), indent=2), encoding="utf-8"
        )

        # snippets
        snippets_dir = out / "snippets"
        snippets_dir.mkdir(exist_ok=True)
        (snippets_dir / "python.json").write_text(
            json.dumps(cls.SNIPPETS_PYTHON, indent=2), encoding="utf-8"
        )
        (snippets_dir / "typescript.json").write_text(
            json.dumps(cls.SNIPPETS_TYPESCRIPT, indent=2), encoding="utf-8"
        )

        # src/extension.ts stub
        src_dir = out / "src"
        src_dir.mkdir(exist_ok=True)
        (src_dir / "extension.ts").write_text(
            cls._EXTENSION_TS, encoding="utf-8"
        )

        # README
        (out / "README.md").write_text(
            "# Eden VS Code Extension\n\n\nGenerate environments, run benchmarks, and inspect traces from VS Code.\n",
            encoding="utf-8",
        )

        logger.info("VS Code extension boilerplate written to %s", out)
        return out

    _EXTENSION_TS: str = '''import * as vscode from "vscode";
import { EdenClient } from "@eden/sdk";

let client: EdenClient | undefined;

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration("eden");
    const apiKey = config.get<string>("apiKey");
    const baseUrl = config.get<string>("baseUrl");

    if (apiKey) {
        client = new EdenClient({ apiKey, baseURL: baseUrl });
    }

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand("eden.generateEnvironment", async () => {
            if (!client) {
                vscode.window.showErrorMessage("Set eden.apiKey in settings first.");
                return;
            }
            const desc = await vscode.window.showInputBox({
                prompt: "Describe the environment you need",
            });
            if (!desc) return;
            vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: "Generating environment..." },
                async () => {
                    const env = await client!.environments.create({ description: desc });
                    vscode.window.showInformationMessage(`Environment created: ${env.id}`);
                }
            );
        }),

        vscode.commands.registerCommand("eden.wrapWithTrace", async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const selection = editor.selection;
            const text = editor.document.getText(selection);
            const wrapped = `@trace_agent(environment_id="env_id")\\n${text}`;
            editor.edit((editBuilder) => {
                editBuilder.replace(selection, wrapped);
            });
        }),

        vscode.commands.registerCommand("eden.openPortal", () => {
            vscode.env.openExternal(vscode.Uri.parse("https://portal.eden.dev"));
        }),
    );
}

export function deactivate() {
    client = undefined;
}
'''


# ──────────────────────────────────────────────────────────────────────────
# Cursor Plugin Stub
# ──────────────────────────────────────────────────────────────────────────


class CursorPluginStub:
    """Stub for generating a Cursor (cursor.com) editor plugin."""

    @classmethod
    def generate_boilerplate(cls, output_dir: str | Path) -> Path:
        """Generate a Cursor plugin boilerplate."""
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)

        # Cursor uses a simple JSON manifest + JS handlers
        manifest = {
            "name": "eden-cursor",
            "version": "0.1.0",
            "description": "Eden integration for Cursor editor",
            "activation": ["onLoad"],
            "commands": [
                {
                    "id": "eden.generateEnvironment",
                    "title": "Generate Eden Environment",
                    "description": "Create a new environment via Eden",
                },
                {
                    "id": "eden.runBenchmark",
                    "title": "Run Eden Benchmark",
                    "description": "Execute a benchmark suite",
                },
                {
                    "id": "eden.viewTrace",
                    "title": "View Eden Trace",
                    "description": "Open trace in portal",
                },
            ],
            "hooks": {
                "onLoad": "src/main.js",
                "onSave": "src/onSave.js",
            },
        }

        (out / "manifest.json").write_text(
            json.dumps(manifest, indent=2), encoding="utf-8"
        )

        src_dir = out / "src"
        src_dir.mkdir(exist_ok=True)

        (src_dir / "main.js").write_text(
            cls._MAIN_JS, encoding="utf-8"
        )
        (src_dir / "onSave.js").write_text(
            cls._ON_SAVE_JS, encoding="utf-8"
        )

        (out / "README.md").write_text(
            "# Eden Cursor Plugin\n\nCursor editor integration for Eden.\n",
            encoding="utf-8",
        )

        logger.info("Cursor plugin boilerplate written to %s", out)
        return out

    _MAIN_JS: str = '''// Eden Cursor Plugin — main entry point
const { cursor } = require("cursor-api");

function activate(context) {
    cursor.commands.register("eden.generateEnvironment", async () => {
        const desc = await cursor.ui.prompt("Describe the environment:");
        if (!desc) return;
        cursor.ui.showNotification("Generating environment...");
        // Call Eden API via the sandbox or production endpoint
        // const result = await fetch("https://api.eden.ai/v1/environments", ...);
        cursor.ui.showNotification("Environment generated! Check the portal.");
    });

    cursor.commands.register("eden.runBenchmark", async () => {
        cursor.ui.showNotification("Benchmark queued.");
    });
}

module.exports = { activate };
'''

    _ON_SAVE_JS: str = '''// Eden Cursor Plugin — on-save hook
const { cursor } = require("cursor-api");

module.exports = function onSave(document) {
    // Auto-detect Eden environment files and offer validation
    if (document.filename.endsWith("_env.py")) {
        cursor.ui.showNotification("Eden environment file saved. Run tests with Cmd+Shift+E.");
    }
};
'''


# ──────────────────────────────────────────────────────────────────────────
# LSP Server Stub
# ──────────────────────────────────────────────────────────────────────────


class LSPServerStub:
    """Stub for an Eden Language Server Protocol (LSP) server.

    Provides autocomplete for Eden SDK methods, environment IDs,
    and configuration keys within Python and TypeScript files.
    """

    CAPABILITIES: dict[str, Any] = {
        "textDocumentSync": {"openClose": True, "change": 1},
        "completionProvider": {
            "triggerCharacters": [".", "("],
            "resolveProvider": False,
        },
        "hoverProvider": True,
        "diagnosticProvider": {
            "interFileDependencies": True,
            "workspaceDiagnostics": False,
        },
    }

    @classmethod
    def generate_boilerplate(cls, output_dir: str | Path) -> Path:
        """Generate LSP server boilerplate."""
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)

        (out / "server.py").write_text(
            cls._SERVER_PY, encoding="utf-8"
        )
        (out / "README.md").write_text(
            "# Eden LSP Server\n\nProvides autocomplete, hover info, and diagnostics for Eden SDK.\n",
            encoding="utf-8",
        )

        logger.info("LSP server boilerplate written to %s", out)
        return out

    _SERVER_PY: str = '''"""Eden LSP Server — lightweight language server for SDK autocomplete."""

from lsprotocol.types import (
    INITIALIZE,
    TEXT_DOCUMENT_COMPLETION,
    TEXT_DOCUMENT_HOVER,
    CompletionItem,
    CompletionList,
    CompletionParams,
    Hover,
    HoverParams,
    InitializeParams,
    InitializeResult,
    ServerCapabilities,
    TextDocumentSyncKind,
)
from pygls.server import LanguageServer

server = LanguageServer("eden-lsp", "v0.1.0")

# Eden SDK completion items
_EDEN_COMPLETIONS = [
    CompletionItem(label="eden.environments.create", detail="Create an environment"),
    CompletionItem(label="eden.environments.get", detail="Get environment by ID"),
    CompletionItem(label="eden.jobs.create", detail="Create a generation job"),
    CompletionItem(label="eden.jobs.stream", detail="Stream job progress"),
    CompletionItem(label="eden.benchmarks.execute", detail="Run a benchmark"),
    CompletionItem(label="eden.datasets.create_from_traces", detail="Create dataset from traces"),
    CompletionItem(label="trace_agent", detail="Decorator to auto-trace an agent"),
    CompletionItem(label="eden.wrap_environment", detail="Wrap a Gymnasium environment"),
]


@server.feature(INITIALIZE)
def initialize(params: InitializeParams) -> InitializeResult:
    return InitializeResult(
        capabilities=ServerCapabilities(
            text_document_sync=TextDocumentSyncKind.Full,
            completion_provider={"trigger_characters": ["."]},
            hover_provider=True,
        )
    )


@server.feature(TEXT_DOCUMENT_COMPLETION)
def completions(params: CompletionParams) -> CompletionList:
    return CompletionList(is_incomplete=False, items=_EDEN_COMPLETIONS)


@server.feature(TEXT_DOCUMENT_HOVER)
def hover(params: HoverParams) -> Hover | None:
    # Simple hover based on word under cursor
    return Hover(contents="Eden SDK method. See docs at https://docs.eden.dev")


if __name__ == "__main__":
    server.start_io()
'''
