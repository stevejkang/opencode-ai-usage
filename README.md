# opencode-ai-usage

An [OpenCode](https://opencode.ai) TUI sidebar plugin that displays AI provider usage in one unified sidebar. Each detected provider gets its own collapsible section with rate limit windows, reset countdowns, and account info.

**Mixed mode** (default):

```
▼ Claude Usage
 admin@example.com
 Session       resets in 3h 16m
 ━━━━━━━━─────────────────  31%
 Weekly         resets in 4d 5h
 ━━━──────────────────────  11%

▼ OpenAI Usage
 user@example.com
 Session       resets in 1h 42m
 ━━━━━━━━━━━━━━────────────  46%
 Weekly         resets in 2d 9h
 ━━━━━━────────────────────  22%
```

## Install

Paste below into your OpenCode.

```
Install and configure opencode-ai-usage by following the instructions here:
https://raw.githubusercontent.com/stevejkang/opencode-ai-usage/refs/heads/main/docs/installation.md
```

### Manual setup

**`~/.config/opencode/tui.json`**

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [["opencode-ai-usage", { "enabled": true }]]
}
```

### Local path

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [["./path/to/opencode-ai-usage/src/tui.tsx", { "enabled": true }]]
}
```

## Options

```json
{
  "plugin": [
    [
      "opencode-ai-usage",
      {
        "enabled": true,
        "disabledProviders": [],
        "displayMode": "mixed",
        "showRemaining": false,
        "providers": {
          "claude": { "refreshInterval": 60, "headerColor": "#E07A3A" },
          "openai": { "refreshInterval": 30, "headerColor": "#10A37F" }
        }
      }
    ]
  ]
}
```

| Option                           | Default   | Description                                                 |
| -------------------------------- | --------- | ----------------------------------------------------------- |
| `disabledProviders`              | `[]`      | Provider IDs to skip entirely, e.g. `["openai"]`            |
| `displayMode`                    | `"mixed"` | `"mixed"`, `"text"`, or `"bar"` (see below)                 |
| `showRemaining`                  | `false`   | Show remaining capacity instead of used (see below)         |
| `providers.<id>.refreshInterval` |           | Seconds between data refreshes (claude: `60`, openai: `30`) |
| `providers.<id>.headerColor`     |           | Section header color (claude: `#E07A3A`, openai: `#10A37F`) |

Provider IDs currently available: `claude`, `openai`, etc. Use these in `disabledProviders` and as keys under `providers`.

### `displayMode`

**Text mode** (`"displayMode": "text"`):

```
▼ Claude Usage
 admin@example.com
 Session      31%  resets in 3h 16m
 Weekly       11%  resets in 4d 5h
```

**Bar mode** (`"displayMode": "bar"`):

```
▼ Claude Usage
 admin@example.com
 Session  █████░░░░░░░░░  31% (3h 16m)
 Weekly   ██░░░░░░░░░░░░  11% (4d 5h)
```

### `showRemaining`

By default, bars and percentages track how much of a window you've _used_. Setting `showRemaining: true` flips the math: bars fill with what's left, and the percentage shown is `100 - used%`. Color grading flips with it, going from a calm default toward warning and danger colors as the remaining amount shrinks, rather than as usage grows.

## Supported Providers

| Provider       | ID       | Detection                                                                         | Requirements                                                                  |
| -------------- | -------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Claude         | `claude` | OAuth token from any of: env var, credentials file, OpenCode auth, macOS Keychain | Logged in via Claude CLI, OpenCode auth, or `CLAUDE_CODE_OAUTH_TOKEN` env var |
| OpenAI (Codex) | `openai` | Codex CLI binary in PATH                                                          | [Codex CLI](https://openai.com/codex) installed and logged in (`codex login`) |

Providers are detected automatically on startup. If a provider's requirements are not met, its section is hidden entirely.

## Requirements

- [OpenCode](https://opencode.ai) with plugin support (`@opencode-ai/plugin` >= 1.4.3)

## Development

```bash
git clone https://github.com/stevejkang/opencode-ai-usage.git
cd opencode-ai-usage
bun install
```

```bash
bun run test
bun run typecheck
bun run lint
bun run format
```

## License

MIT
