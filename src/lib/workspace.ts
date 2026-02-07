import { join } from "path";
import { mkdirSync } from "fs";
import type { ScaffoldOptions } from "./types";
import { buildUvEnv } from "./env";

export function generateRootPyproject(libraryName: string, packages: string[]): string {
  const depsStr = packages.map((p) => `    "${p}",`).join("\n");
  const snakeName = libraryName.replace(/-/g, "_");
  return `[project]
name = "${libraryName}"
version = "0.1.0"
description = "Agent-maintained Python library"
requires-python = ">=3.13"
dependencies = [
${depsStr}
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/${snakeName}"]

[tool.uv]
dev-dependencies = ["pytest>=8.0.0"]
`;
}

export function generateUtilsPy(libraryName: string): string {
  return `"""Utility functions for ${libraryName}."""
import numpy as np
import pandas as pd


def hello() -> str:
    return "Hello from ${libraryName}!"


def create_sample_dataframe() -> pd.DataFrame:
    return pd.DataFrame({"x": np.arange(10), "y": np.random.randn(10)})
`;
}

export function generateTestUtilsPy(libraryName: string): string {
  const snakeName = libraryName.replace(/-/g, "_");
  return `from ${snakeName}.utils import hello, create_sample_dataframe


def test_hello():
    assert hello() == "Hello from ${libraryName}!"


def test_create_sample_dataframe():
    df = create_sample_dataframe()
    assert len(df) == 10
`;
}

export function generateReadme(libraryName: string): string {
  return `# ${libraryName}

Agent-maintained Python library for data science workflows.

## Usage

\`\`\`python
from ${libraryName.replace(/-/g, "_")}.utils import hello, create_sample_dataframe

print(hello())
df = create_sample_dataframe()
\`\`\`

## Running Tests

\`\`\`bash
pytest
\`\`\`
`;
}

export function generateOpencodeConfig(): string {
  return JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    "permission": {
      "edit": "ask",
      "bash": "ask",
      "webfetch": "allow",
      "write": "allow",
      "codesearch": "allow",
      "read": "allow",
      "grep": "ask",
      "glob": "allow",
      "list": "allow",
      "lsp": "allow",
      "skill": "allow",
      "todowrite": "allow",
      "todoread": "allow",
      "question": "allow"
    },
    "plugin": ["@processmesh-plugins/email", "opencode-scheduler"]
  }, null, 2);
}

export function generateAgentsMd(libraryName: string): string {
  const snakeName = libraryName.replace(/-/g, "_");
  return `# Agent Instructions

You are a data scientist serving business users. Your users do not care about code—they care about **results**. Deliver insights, not implementation details.

## Identity

- Expert Python developer maintaining **one codebase**: this workspace
- Write code as a library author in \`src/${snakeName}/\`
- Consume that library in scripts and notebooks
- Prioritize: maintainability, simplicity, long-term sustainability

## Commands

\`\`\`bash
# Type check (always before committing)
ty check

# Run tests
uv run pytest

# Run a script
uv run python <script.py>

# Add dependencies
uv add <package>
uv add --dev <package>

# Sync environment
uv sync
\`\`\`

## Git Workflow

Commit small, atomic units of work:

\`\`\`bash
ty check && git add <files> && git commit -m "<message>"
\`\`\`

Each commit must:
1. Pass \`ty check\`
2. Be a single logical change
3. Have a descriptive message

## Code Style

- Type hints on all function signatures
- Docstrings only when behavior is non-obvious
- Small, focused functions
- Explicit over implicit

## Project Structure

\`\`\`
pyproject.toml        # Dependencies (use uv, never pip)
src/${snakeName}/     # Library code (reusable, tested)
tests/                # Tests for library code
.venv/                # Virtual environment (managed by uv)
\`\`\`

## Boundaries

### Always

- Type check with \`ty check\` before committing
- Commit in small, logical units
- Deliver results, not code explanations
- Keep it simple

### Ask First

- Adding new dependencies
- Changing project structure

### Never

- Commit code that fails \`ty check\`
- Use \`pip install\` (use \`uv add\`)
- Activate venv manually (use \`uv run\`)
- Over-engineer for hypothetical needs
- Explain code to users—give them results
`;
}

export async function createWorkspaceScaffold(
  workspacePath: string,
  libraryName: string,
  packages: string[],
  options: ScaffoldOptions = {},
): Promise<void> {
  console.log(`\nCreating workspace scaffold at ${workspacePath}...`);
  const snakeName = libraryName.replace(/-/g, "_");
  const srcDir = join(workspacePath, "src", snakeName);
  const testsDir = join(workspacePath, "tests");

  mkdirSync(srcDir, { recursive: true });
  mkdirSync(testsDir, { recursive: true });

  await Bun.write(join(workspacePath, "pyproject.toml"), generateRootPyproject(libraryName, packages));
  await Bun.write(join(srcDir, "__init__.py"), `"""${libraryName} package."""\n`);
  await Bun.write(join(srcDir, "utils.py"), generateUtilsPy(libraryName));
  await Bun.write(join(testsDir, "__init__.py"), "");
  await Bun.write(join(testsDir, "test_utils.py"), generateTestUtilsPy(libraryName));
  await Bun.write(join(workspacePath, "README.md"), generateReadme(libraryName));
  if (!options.skipAgentsMd) {
    await Bun.write(join(workspacePath, "AGENTS.md"), generateAgentsMd(libraryName));
  }
  await Bun.write(join(workspacePath, "opencode.json"), generateOpencodeConfig());

  console.log(`  Created workspace scaffold with library "${libraryName}"`);
}

export async function syncWorkspace(prefix: string, workspacePath: string): Promise<void> {
  console.log(`\nSyncing workspace dependencies...`);
  const uv = join(prefix, "bin", "uv");

  const proc = Bun.spawn([uv, "sync"], {
    cwd: workspacePath,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      ...buildUvEnv(prefix),
      PATH: `${join(prefix, "bin")}:${process.env.PATH}`,
    },
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`Workspace sync failed (${exitCode})`);
  console.log("  Workspace synced successfully.");
}
