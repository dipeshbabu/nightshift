# Nightshift

Nightshift is a Bun-native CLI that installs and runs OpenCode in an isolated, reproducible toolchain, with an optional custom TUI built on OpenTUI + Solid.

It is designed for teams that want a consistent OpenCode environment (pinned tool versions, bundled Python tooling, and a focused terminal UI) without relying on system installs.

## What you get

- An isolated toolchain in a prefix directory (OpenCode, Python, uv, ripgrep).
- A data-science venv with NumPy and pandas preinstalled.
- A Nightshift TUI that attaches to an OpenCode server and adds session, model, and command workflows.
- A single Bun-driven build pipeline that emits standalone binaries.

## Requirements

- macOS or Linux (x64 or arm64).
- Bun installed and on PATH.
- System tools: `curl`, `tar`, and `unzip`.
- Network access to GitHub releases for OpenCode and tool downloads.

## Quickstart

Install dependencies:

```bash
bun install
```

Build a single binary for your current platform:

```bash
bun run build:single
```

Install tools to a prefix and launch the TUI:

```bash
./dist/nightshift-<os>-<arch>/bin/nightshift install --prefix ~/.nightshift
./dist/nightshift-<os>-<arch>/bin/nightshift run --prefix ~/.nightshift --run-nightshift-tui
```

## CLI usage

Nightshift exposes three main commands:

- `install` - download and install tools into a prefix.
- `run` - launch OpenCode with an isolated PATH.
- `attach` - connect the Nightshift TUI to an existing OpenCode server.

Examples:

```bash
# Install toolchain into a local prefix
nightshift install --prefix ~/.nightshift

# Run OpenCode with isolated tools
nightshift run --prefix ~/.nightshift -- --continue

# Start OpenCode in server mode and attach Nightshift TUI
nightshift run --prefix ~/.nightshift --run-nightshift-tui

# Attach to an existing OpenCode server
nightshift attach http://127.0.0.1:4096 --session <session-id>
```

Notes:

- Use `--` to pass extra arguments directly to OpenCode.
- `run --run-nightshift-tui` starts `opencode serve` on a random port and attaches the TUI.

## Toolchain layout

Nightshift installs into a prefix you control:

```
<prefix>/
  bin/          # symlinks: opencode, python, uv, rg
  tools/        # extracted tool archives
  venvs/
    data-science/  # numpy + pandas
```

Pinned tool versions live in `src/index.ts` so you can update them centrally.

## Configuration

Nightshift delegates configuration to OpenCode. If you already use OpenCode config files, they are picked up automatically.

Common locations:

- `opencode.json` in your project root
- `~/.config/opencode/opencode.json` for global settings

OpenCode configuration supports model defaults, keybind overrides, custom commands, MCP servers, and more.

## TUI basics

The Nightshift TUI is a focused shell around OpenCode sessions. A few useful defaults:

- `Ctrl+P` opens the command palette.
- `Ctrl+X` is the leader key for many shortcuts (see the in-app help).
- `/models`, `/sessions`, and `/status` are common slash commands.
- Use `/help` for a complete, up-to-date list of actions and keybinds.

## Development

Run from source:

```bash
bun run start -- install --prefix ~/.nightshift
bun run start -- run --prefix ~/.nightshift --run-nightshift-tui
```

Attach to an existing server:

```bash
bun run start -- attach http://127.0.0.1:4096
```

Debug the CLI (break on start):

```bash
bun run dev:debug -- run --prefix ~/.nightshift --run-nightshift-tui
```

Build all targets:

```bash
bun run build
```

Build output is written to `dist/nightshift-<os>-<arch>/bin/nightshift`.

## Project layout

- `src/index.ts` - CLI entrypoint, installs tools, runs OpenCode, and launches the TUI.
- `src/cli/cmd/tui/tui/` - Nightshift TUI (OpenTUI + Solid).
- `script/build.ts` - Bun build script for cross-platform binaries.
- `bunfig.toml` - Bun bundler and JSX settings.

## Contributing

Contributions are welcome. A typical workflow:

1. Fork and clone the repo.
2. `bun install`
3. Make changes and run the CLI locally.
4. `bun run build:single` to ensure builds still work.
5. Open a PR with context and screenshots for UI changes.

If you are unsure where to start, open an issue with your idea or bug report first.

## Troubleshooting

- If the TUI cannot connect, verify `opencode serve` is reachable at the URL you provided.
- The SDK layer logs to `/tmp/nightshift-sdk.log` to help debug connection issues.
- Re-run `install` after changing tool versions in `src/index.ts`.

## License

No license file is included in this repository yet.
