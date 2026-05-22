# pmx: unix utilities to deal with code agents

No TUI, no REPL, the agent loop is a small bash script.

A set of small, composable tools that together form an LLM agent loop. Each tool does one thing. `zmx` provides session history and tool execution.

## Tools

- **`llm`** - Sends a conversation to an LLM and streams the response. Reads tool definitions from stdin, messages from a JSON file. Streams text to stderr (human-readable), emits full assistant JSON to stdout (machine-readable).
- **`ctx`** - Manages message history as a JSON file. Add user/assistant/tool-result messages, view, edit, or reset context.
- **`tool`** - Resolves LLM tool calls and handles edit operations. Reads assistant message JSON from stdin and prints one JSON line per tool call, or applies file edits directly.

## Core Loop

```bash
ctx add user "fix the bug"

while true; do
  response=$(tool list | llm "$(ctx path)" | ctx add-assistant | sed -n '1p')
  calls=$(echo "$response" | tool) || break

  while IFS= read -r call; do
    id=$(echo "$call" | jq -r '.id')
    name=$(echo "$call" | jq -r '.name')
    args=$(echo "$call" | jq -r '.args')
  done <<< "$calls"
done
```

## Install

```bash
mise install
npm install
mise run install
```

This will install the scripts into `~/.local/bin` so make sure that's in your `PATH`.

We also crawl `~/.pi` for provider settings.

## Usage

```bash
zmx attach dev            # first attach to a session

pmx "fix the bug"         # run agent with a prompt
pmx                       # use zmx scrollback as context
pmx -e                    # edit prompt in $EDITOR

ctx list                     # list all available sessions
ctx path                     # print location of messages.json
ctx view                     # print human readable context
ctx edit                     # edit conversation in $EDITOR (delete lines to remove messages)
ctx reset                    # wipe context
ctx stats                    # model name, token usage, message count
ctx last-text                # print the last assistant text response (no tool calls)
ctx add user "msg"           # adds user message
ctx add assistant <json>     # adds assistant message (JSON)
ctx add tool-result <id> <name> <text>  # adds tool result message
ctx add-assistant            # stdin: append assistant message JSON
ctx add-result "$id" "$name" # stdin: append tool result text

tool list                    # print tool definitions as JSON
tool                         # pipe mode: stdin assistant message JSON -> stdout one JSON line per tool call
tool edit <id> <file> <edits>  # apply edits to a file and report result

<tools.json> | llm <messages.json>  # read tools from stdin, send messages to LLM
```

Tool calls execute in a sibling zmx session (`$ZMX_SESSION.tools`) so you can `zmx attach <session>.tools` to watch with full ANSI output.

## Data Flow

```
pmx "prompt"
  -> ctx add user
  -> tool list | llm messages.json  (streams to terminal, JSON to stdout)
  -> ctx add-assistant
  -> extract & execute tool calls via zmx run
  -> ctx add tool-result
  -> loop until no tool calls
```

## Environment

| Variable       | Description                        | Default                                         |
| -------------- | ---------------------------------- | ----------------------------------------------- |
| `ZMX_SESSION`  | Required. The zmx session to use.  | (none)                                          |
| `LLM_PROVIDER` | LLM provider                       | from `~/.pi/agent/settings.json` or `anthropic` |
| `LLM_MODEL`    | Model name                         | from settings or `claude-sonnet-4-5`            |
| `LLM_SYSTEM`   | Override the default system prompt | (none)                                          |
| `EDITOR`       | Editor for `ctx edit`              | `vi`                                            |

## Requirements

- `pi` - purely because we crawl `~/.pi` for provider settings
- `zmx` - session management and tool execution
- `jq` - for the bash script
- Node.js (for `llm`, `ctx`, `tool` scripts)
