# TinyClaude Project Overview

## Objective
The goal of this project is to recreate a general-purpose Agent workflow similar to pi-agent, focusing on building autonomous coding agents that can interact with the file system, execute commands, and manage multi-step tasks.

## Current Implementation: claude-code
The project currently implements a series of increasingly sophisticated agent loops in the `learn-claude-code` directory:

### s01-agent-loop.py
- Basic agent implementation with a single tool (`run_bash`)
- Uses LLM function calling to execute shell commands
- Includes logging functionality to track requests and responses
- Simple REPL interface for user interaction

### s02-agent-loop.py
- Enhanced agent with multiple file system tools:
  - `bash`: Execute shell commands
  - `read_file`: Read file contents
  - `write_file`: Write content to files
  - `edit_file`: Replace text in existing files
- Implements path safety checks to prevent directory traversal
- Improved error handling and logging

### s03-todo-write.py
- Advanced agent with task planning capabilities
- Adds a `todo` tool for managing multi-step workflows
- Todo manager enforces constraints:
  - Maximum of 20 todos
  - Only one todo can be "in_progress" at a time
  - Valid statuses: pending, in_progress, completed
- Includes reminder system to prompt agent to update todos after 3 rounds without todo updates
- Visual todo rendering with completion tracking

## Architecture
The agent architecture follows these principles:
1. **Tool-based interaction**: The agent interacts with the environment exclusively through defined tools
2. **Safety first**: Path validation prevents directory traversal attacks
3. **Transparent operation**: All LLM requests and responses are logged for debugging
4. **Task decomposition**: Complex tasks are broken down into manageable steps using the todo system

## Configuration
The project uses environment variables for configuration:
- `API_URL`: API endpoint for the LLM service
- `OPENROUTER_KEY`: Authentication key for the API
- `MODEL`: Specific model to use (defaults to "qwen3-max")

## Learning Resources
The project references several learning resources:
- [Learn Claude Agents course](https://learn-claude-agents.vercel.app/en/s01/)
- [mini-claw repository](https://github.com/htlin222/mini-claw/tree/main)
- [nanoagent repository](https://github.com/hbbio/nanoagent/tree/main) (marked as "to learn")

## Next Steps
Based on the README, the project aims to continue learning from other agent implementations like nanoagent to further enhance capabilities.