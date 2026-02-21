/q
inyClaude Project Report

## Overview
TinyClaude is a research project aimed at reproducing the pi-agent universal agent workflow. The project explores minimal, dependency-free implementations of agentic coding loops with tool-augmented LLMs. It consists of multiple experimental implementations in both Python and TypeScript/Bun, each demonstrating different aspects of agent architecture.

## Core Components

### 1. Agent Loop Architecture
The fundamental pattern across all implementations is an **LLM ↔ Tool interaction loop**:
- User input is sent to the LLM along with conversation history
- LLM responds with either direct text output or tool calls
- When tool calls are present, they are executed and results are fed back to the LLM
- This process repeats until the LLM produces a final response without tool calls

### 2. Available Tools
All implementations provide a consistent set of file system and shell tools:
- **read**: Read files (with optional line range)
- **write**: Create or overwrite files
- **edit**: Find-and-replace operations in files
- **glob**: List files matching patterns
- **grep**: Regex search across multiple files
- **bash**: Execute shell commands with timeout protection

### 3. Implementation Variants

#### Python Implementations (`agent-loop/`)
- **agent-v1.py**: Minimal (~280 lines) pure Python implementation with zero dependencies
- Uses standard library only (urllib, subprocess, pathlib)
- Demonstrates the core agent loop pattern with comprehensive logging
- Configurable via `.env` file for API endpoints and models

#### TypeScript/Bun Implementations
- **nanocode/nanocode.ts**: Full-featured agent with rich terminal UI, colored output, and detailed logging
- **planning-agent/planning_agent.ts**: Advanced two-phase agent with explicit planning and execution stages
  - **Planning Phase**: LLM generates structured JSON plan with goal, analysis, and ordered steps
  - **User Approval**: Plan is displayed for user review/edit before execution
  - **Execution Phase**: Each step is executed individually with access to previous step results
  - Includes context management to prevent token overflow during long executions

#### Claude-Specific Implementation (`claude-code/`)
- Simplified agent optimized for Claude-style interactions
- Single `run_bash` tool focused on command-line problem solving
- Emphasizes "Act, don't explain" philosophy

## Technical Design Principles

### Minimal Dependencies
- Python versions use only standard library modules
- TypeScript versions leverage Bun runtime for built-in tooling
- No external package dependencies required

### Safety Considerations
- Command execution includes timeout limits (30-120 seconds)
- Dangerous commands are blocked in some implementations
- File operations include proper error handling

### Observability
- Comprehensive logging to debug files (`agent_debug.log`, `api_responses.log`, `actions.log`)
- Real-time terminal feedback with colored output and progress indicators
- Usage statistics tracking for tool calls and API requests

## Configuration
The project uses a simple `.env` configuration file:
```
OPENROUTER_KEY="sk-081adacbc7d6451eaa95cfbcd2385b2d"
API_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
MODEL="qwen3-max"
```

This allows easy switching between different LLM providers and models while maintaining consistent agent behavior.

## Research Goals
The project serves as a testbed for exploring:
- Minimal viable agent architectures
- Tool-augmented reasoning patterns
- Planning vs. reactive agent strategies
- Context management in multi-turn interactions
- Cross-language implementation patterns

The implementations demonstrate that sophisticated agentic behavior can be achieved with remarkably simple codebases, making them excellent educational resources for understanding the fundamentals of LLM-powered agents.
