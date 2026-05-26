# ciscollm-cli

`ciscollm-cli` is a Cisco IOS automation agent CLI for configuration, troubleshooting, and simulation. It supports tool-calling with an LLM, safety guardrails, rollback handling, and a mock switch/router environment for offline testing.

## Installation

Install the published package globally:

```bash
npm install -g ciscollm-cli
```

After installation, the `ciscollm` command becomes available in your terminal.

## Quick Start

Show the available commands and flags:

```bash
ciscollm run --help
```

Run the agent in mock mode for a safe offline simulation:

```bash
ciscollm run --protocol mock --goal "Review LAN IP allocation for 192.168.1.0/24"
```

## What It Does

The CLI takes a user goal, sends it to the selected LLM provider, and lets the agent choose Cisco IOS tool calls step by step.

It can:
- inspect and modify Cisco-style configuration
- validate commands with guardrails
- roll back failed configuration changes
- simulate interfaces, IP addresses, shell commands, and ping checks in mock mode

## Common Usage

Start a mock session for learning or testing:

```bash
ciscollm run --protocol mock --goal "Configure 192.168.1.1/24 on LAN A for 25 hosts"
```

Use a local LLM endpoint:

```bash
ciscollm run --provider local --local-type lmstudio --endpoint http://127.0.0.1:1234/v1 --protocol mock --goal "Open privileged exec and review IP design"
```

Use cloud inference with an API key:

```bash
ciscollm run --provider cloud --api-key YOUR_OPENROUTER_KEY --protocol mock --goal "Check interface status"
```

Enable strict command-reference enforcement:

```bash
ciscollm run --strict-command-ref --protocol mock --goal "Review LAN design"
```

Disable startup telemetry if you want quieter output:

```bash
ciscollm run --no-ref-telemetry --protocol mock --goal "Review LAN design"
```

## Command Options

- `--protocol <type>`: Selects the device connection mode. Supported values: `serial`, `ssh`, `telnet`, `mock`.
- `--provider <type>`: Selects the LLM provider. Supported values: `local`, `cloud`.
- `--local-type <type>`: Chooses the local LLM server flavor. Supported values: `ollama`, `lmstudio`.
- `--endpoint <url>`: Sets the LLM API endpoint.
- `--model <name>`: Sets the model name to use.
- `--strict-command-ref`: Blocks commands that are not found in the command-reference index.
- `--no-ref-telemetry`: Turns off command-reference startup telemetry.
- `--goal <intent>`: Describes the configuration or troubleshooting task.

## Local LLM Notes

If you use a local provider, make sure the endpoint is already running before starting the CLI.

- Ollama usually listens on `http://127.0.0.1:11434/v1`
- LM Studio usually listens on `http://127.0.0.1:1234/v1`

If the endpoint is unavailable, the CLI will stop early with a clear preflight error.

## Mock Mode

Mock mode is designed for safe offline testing.

It simulates:
- device connection and prompt modes
- interface configuration
- ping behavior
- command parsing errors
- shell variable and function behavior

This is the recommended mode when you want to test agent behavior without hardware.

## Troubleshooting

- If you see `ENEEDAUTH`, you are not logged into npm with an account that can publish or access the package.
- If the CLI says the LLM endpoint is unreachable, start the local server or update `--endpoint`.
- If a command is blocked in strict mode, it was not matched in the command-reference index.

## Package Name

The package name on npm is `ciscollm-cli`, and it exposes the `ciscollm` executable through the package `bin` entry.
