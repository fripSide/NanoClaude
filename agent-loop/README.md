# agent-loop

A minimal agentic coding loop in Python (~280 lines, zero pip dependencies).

## Quick Start

```bash
# Make sure ../.env has your API config:
#   API_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
#   OPENROUTER_KEY="your-key"
#   MODEL="qwen3-max"

python3 agent.py
```

## Commands

| Command | Description |
|---------|-------------|
| `/q` or `exit` | Quit |
| `/c` | Clear conversation history |
| `/stats` | Show usage statistics |
| `/stats path` | Save stats to a file |

## Tools

| Tool | Description |
|------|-------------|
| `read` | Read a file (with optional line range) |
| `write` | Create or overwrite a file |
| `edit` | Find-and-replace in a file |
| `glob` | List files matching a pattern |
| `grep` | Regex search across files |
| `bash` | Run a shell command (30s timeout) |

## Architecture

Agent Loop 的核心是一个 **LLM ↔ Tool 交互循环**：

1. 将用户输入追加到 `messages`，发送给 LLM
2. LLM 返回文本回复和/或工具调用（tool_calls）
3. 如果有工具调用 → 执行工具 → 把结果追加到 messages → 回到第 2 步
4. 如果没有工具调用 → 输出文本回复 → 结束本轮，等待用户下一次输入

### v1-伪代码

```
function agent_loop(messages, system_prompt):
    loop:
        response = call_llm(messages, system_prompt, tools)

        if response.text:
            print(response.text)

        if response.tool_calls is empty:
            messages.append(assistant_message(response.text))
            return                          # ← 本轮结束

        # 有工具调用 → 执行并把结果反馈给 LLM
        messages.append(assistant_message(response.text, response.tool_calls))

        for each tool_call in response.tool_calls:
            result = execute_tool(tool_call.name, tool_call.args)
            messages.append(tool_message(tool_call.id, result))

        # → 回到 loop 顶部，带着工具结果再次调用 LLM

function main():
    messages = []
    loop:
        user_input = read_input()
        messages.append(user_message(user_input))
        agent_loop(messages, system_prompt)   # ← 可能经过多轮 LLM↔Tool 交互
```

流程图

```
User input → LLM → tool calls? ─yes─→ execute tools → feed results back ─┐
                       │                                                   │
                       no                                                  │
                       │                                                   │
                       ▼                                                   │
                  print response ◄─────────────────────────────────────────┘
```


### v2-伪代码