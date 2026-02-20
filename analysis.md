# TinyClaude Project Analysis

## Overview

TinyClaude is an implementation of a **pi-agent-like universal agent workflow** that demonstrates how to build autonomous AI agents capable of interacting with codebases and file systems through tool usage. The project provides multiple implementations of agentic loops with varying complexity levels, from minimal to planning-based approaches.

## Core Architecture

The project follows the fundamental **LLM ↔ Tool interaction loop** pattern:

1. User input is sent to the LLM along with conversation history
2. LLM responds with either text output or tool calls (or both)
3. If tool calls are present, they are executed and results are fed back to the LLM
4. The process repeats until the LLM produces a final response without tool calls

This creates an autonomous agent capable of reasoning about tasks and executing them through available tools.

## Key Components

### 1. Agent Implementations

The project contains three main agent implementations:

#### **Agent Loop (Python)**
- **Location**: `agent-loop/agent.py`
- **Size**: ~280 lines with zero dependencies
- **Features**: Minimal implementation using standard library only
- **Tools**: read, write, edit, bash, glob, grep
- **Purpose**: Demonstrates the core agentic loop concept in its simplest form

#### **NanoCode (TypeScript/Bun)**
- **Location**: `nanocode/nanocode.ts`
- **Dependencies**: zod for schema validation
- **Features**: Enhanced TypeScript implementation with better error handling and logging
- **Tools**: Same as Python version but with additional parameters (offset/limit for read, all flag for edit)
- **Purpose**: More robust implementation with better developer experience

#### **Planning Agent (TypeScript/Bun)**
- **Location**: `planning-agent/planning_agent.ts`
- **Dependencies**: zod
- **Features**: Two-phase approach with explicit planning and execution stages
- **Workflow**:
  1. **Planning Phase**: LLM analyzes the task and generates a structured JSON plan
  2. **User Approval**: User can approve, reject, or request edits to the plan
  3. **Execution Phase**: LLM executes each step of the approved plan using available tools
- **Purpose**: Demonstrates more sophisticated agent behavior with explicit planning and user oversight

### 2. Available Tools

All implementations provide the same core set of tools for file system interaction:

- **`read`**: Read files with optional line range specification
- **`write`**: Create or overwrite files
- **`edit`**: Find-and-replace operations in files (with safety checks for multiple matches)
- **`glob`**: List files matching glob patterns
- **`grep`**: Search for regex patterns across files
- **`bash`**: Execute shell commands with 30-second timeout
- **`think`**: (Planning Agent only) Internal reasoning tool with no side effects

### 3. Configuration

The project uses environment variables for API configuration:

- **`API_URL`**: API endpoint (supports OpenAI-compatible APIs like DashScope)
- **`OPENROUTER_KEY`**: API key for authentication
- **`MODEL`**: Model name (defaults to "qwen3-max")

Configuration is loaded from a `.env` file in the project root.

## Technical Design Patterns

### Message Format Conversion
The TypeScript implementations handle conversion between internal message formats and OpenAI-compatible API formats, demonstrating how to work with different LLM providers.

### Context Management
The Planning Agent includes sophisticated context management:
- Truncation of large tool results to prevent context overflow
- Budget-based inclusion of previous step results
- Message compaction for long-running steps

### Error Handling and Safety
- Tool execution timeouts (30 seconds for bash commands)
- File operation safety checks (e.g., edit requires unique matches by default)
- Graceful error handling with informative messages

### Logging and Statistics
- Comprehensive logging to `actions.log` and `api_responses.log`
- Usage statistics tracking (`/stats` command)
- Structured logging format for easy analysis

## Use Cases

This project demonstrates several practical applications:

1. **Codebase Navigation**: Finding and understanding code structure
2. **Automated Refactoring**: Making systematic changes across multiple files
3. **File System Operations**: Creating, modifying, and organizing files
4. **Development Assistance**: Helping with coding tasks through tool-assisted reasoning

## Relationship to pi-agent

The project explicitly aims to "reproduce pi-agent-like universal agent workflow." pi-agent is known for its ability to handle complex software development tasks through autonomous tool usage and planning. TinyClaude captures this essence while providing educational, minimal implementations that are easier to understand and modify.

## Development Workflow

The agents support interactive commands:
- `/q` or `exit`: Quit the session
- `/c`: Clear conversation history
- `/stats [path]`: Display or save usage statistics

This makes them suitable for both interactive use and batch processing scenarios.

## Conclusion

TinyClaude serves as an excellent educational resource for understanding agentic AI systems. By providing multiple implementations of increasing complexity, it demonstrates how simple LLM-tool interaction loops can be extended into sophisticated planning and execution systems. The project's focus on minimalism and clarity makes it accessible for learning while still being practically useful for real-world development tasks.