# pmx: unix utilities to deal with code agents

No TUI, no REPL, the agent loop is a small bash script.

A set of small, composable tools that together form an LLM agent loop. Each tool does one thing. `zmx` provides session history and tool execution.

## Tools

- **`llm`** - Makes an LLM API call. Streams text to stderr (human-readable), emits full assistant JSON to stdout (machine-readable).
- **`ctx`** - Manages message history as a JSON file. Add user/assistant/tool-result messages, view, edit, or reset context.
- **`tool`** - Parses assistant responses for tool calls and resolves them to shell commands.
- **`pmx`** - The agent loop. Orchestrates `llm`, `ctx`, and `tool` in a loop until no more tool calls remain.

## Core Loop

```bash
ctx add user "fix the bug"

while true; do
  response=$(llm "$(ctx path)" "$(tool path)" | ctx add-assistant)
  calls=$(echo "$response" | tool) || break

  while IFS= read -r call; do
    id=$(echo "$call" | jq -r '.id')
    name=$(echo "$call" | jq -r '.name')
    cmd=$(echo "$call" | jq -r '.cmd')
    output=$(eval "$cmd")
    echo "$output" | ctx add-result "$id" "$name"
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
ctx stats                    # meta data
ctx add user "msg"           # adds user message
ctx add-assistant            # stdin messages from llm
ctx add-result "$id" "$name" # stdin tool call result
ctx last-text                # prints the final text from assistant

tool path # print location of tools.json
tool list # print human readable list of tools
tool      # accepts stdin messages from llm api and resolves the tool commands based on template

llm "$(ctx path)" "$(tool path)"  # calls the provider and returns response
```

Tool calls execute in a sibling zmx session (`$ZMX_SESSION.tools`) so you can `zmx attach <session>.tools` to watch with full ANSI output.

## Data Flow

```
pmx "prompt"
  -> ctx add user
  -> llm messages.json  (streams to terminal, JSON to stdout)
  -> ctx add assistant
  -> extract & execute tool calls via zmx run
  -> ctx add tool-result
  -> loop until no tool calls
```

## Requirements

- `pi` - purely because we crawl `~/.pi` for provider settings
- `zmx` - session management and tool execution
- `jq` - for the bash script
- Node.js (for `llm`, `ctx`, `tool` scripts)