# opencode-ai-usage Installation Guide

> This guide is designed for LLM agents to follow step-by-step. Each step includes expected outcomes for verification.

## What is opencode-ai-usage?

An OpenCode TUI sidebar plugin that displays AI provider usage in one unified sidebar. Each detected provider gets its own collapsible section with rate limit windows, reset countdowns, and account info.

## Prerequisites

- [OpenCode](https://opencode.ai) installed and working
- Plugin support (`@opencode-ai/plugin` >= 1.4.3)

## Step 1: Configure the TUI plugin

Edit `~/.config/opencode/tui.json`. Create the file if it doesn't exist.

Add `["opencode-ai-usage", { "enabled": true }]` to the `plugin` array:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [["opencode-ai-usage", { "enabled": true }]]
}
```

**If the file already exists with other plugins**, append to the existing array. Do not replace existing entries:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    ["existing-plugin", { "enabled": true }],
    ["opencode-ai-usage", { "enabled": true }]
  ]
}
```

### Options

All options are optional. Defaults shown:

```json
[
  "opencode-ai-usage",
  {
    "enabled": true,
    "disabledProviders": [],
    "displayMode": "mixed",
    "showRemaining": false,
    "providers": {
      "claude": { "refreshInterval": 60, "headerColor": "#E07A3A" },
      "openai": { "refreshInterval": 30, "headerColor": "#10A37F" },
      "opencode-go": { "refreshInterval": 60, "headerColor": "#FDFCFC" }
    }
  }
]
```

| Option                           | Default   | Description                                                                         |
| -------------------------------- | --------- | ----------------------------------------------------------------------------------- |
| `disabledProviders`              | `[]`      | Provider IDs to skip entirely, e.g. `["openai"]`                                    |
| `displayMode`                    | `"mixed"` | `"mixed"`, `"text"`, or `"bar"` (see below)                                         |
| `showRemaining`                  | `false`   | Show remaining capacity instead of used (see below)                                 |
| `providers.<id>.refreshInterval` |           | Seconds between data refreshes (claude: `60`, openai: `30`, opencode-go: `60`)      |
| `providers.<id>.headerColor`     |           | Section header color (claude: `#E07A3A`, openai: `#10A37F`, opencode-go: `#FDFCFC`) |

Provider IDs currently available: `claude`, `openai`, `opencode-go`.

#### `displayMode`

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

#### `showRemaining`

By default, bars and percentages track how much of a window you've _used_. Setting `showRemaining: true` flips the math: bars fill with what's left, and the percentage shown is `100 - used%`. Color grading flips with it, going from a calm default toward warning and danger colors as the remaining amount shrinks, rather than as usage grows.

## Step 2: Restart OpenCode

The plugin loads at startup. Restart OpenCode to activate.

## Verification

After restart, send a chat message — the sidebar renders after the first message. You should see provider sections:

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
 Monthly       resets in 29d 23h
 ──────────────────────────   0%
```

Only detected providers appear. If a provider's requirements are not met, its section is hidden entirely.

During initial load:

```
▼ Claude Usage
 Loading in 8s...
```

## Supported Providers

| Provider       | ID            | Requirements                                                                                 |
| -------------- | ------------- | -------------------------------------------------------------------------------------------- |
| Claude         | `claude`      | Logged in via Claude CLI, OpenCode auth, or `CLAUDE_CODE_OAUTH_TOKEN` env var                |
| OpenAI (Codex) | `openai`      | [Codex CLI](https://openai.com/codex) installed and logged in (`codex login`)                |
| OpenCode Go    | `opencode-go` | [OpenCode Go](https://opencode.ai) subscription active, connected via `/connect` in OpenCode |

## Troubleshooting

- **Plugin not showing**: Verify `tui.json` exists at `~/.config/opencode/tui.json` and contains the plugin entry. Restart OpenCode after editing. Send a chat message — the sidebar renders only after the first message.
- **Provider section missing**: That provider was not detected. Check its requirements in the table above.
- **"Loading in Ns..."**: Initial load in progress. Data appears once the provider responds.
- **"Failed to fetch usage"**: The provider's API returned an error. After a failure, all OpenCode windows wait before retrying, doubling the wait up to 15 minutes. A rate limit (HTTP 429) can pause refreshes for up to an hour.
- **Data not updating**: Default refresh intervals are 60s (Claude), 30s (OpenAI), and 60s (OpenCode Go). OpenCode windows share one cache, so only one window calls each provider per interval and the others show its result.
- **Stale data badge ("updated Xm ago")**: The provider hasn't refreshed in over twice the refresh interval, usually because of the failure backoff above or after the computer wakes from sleep. Clears on the next successful fetch.

## Uninstall

1. Remove `["opencode-ai-usage", { "enabled": true }]` from `~/.config/opencode/tui.json` plugin array
2. Restart OpenCode
3. Optionally delete cache: `rm -rf ~/.cache/opencode-ai-usage/`
