import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path
from datetime import datetime


WORKDIR = Path.cwd()
SYSTEM = f"You are a coding agent at {WORKDIR}. Use the task tool to delegate exploration or subtasks."
SUBAGENT_SYSTEM = f"You are a coding subagent at {WORKDIR}. Complete the given task, then summarize your findings."

# ─── Config ──────────────────────────────────────────────────────────


def load_env():
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip().strip('"'))

load_env()
API_URL = os.environ.get("API_URL", "")
API_KEY = os.environ.get("OPENROUTER_KEY", "")
MODEL = os.environ.get("MODEL", "qwen3-max")


# ─── Logging ─────────────────────────────────────────────────────────

LOG_FILE = Path(__file__).resolve().parent / "agent_debug.log"
if os.path.exists(LOG_FILE):
    os.remove(LOG_FILE)

def compact_json(obj, max_str_len=80):
    """Keep all JSON keys, truncate string values to one line."""
    if isinstance(obj, dict):
        return {k: compact_json(v, max_str_len) for k, v in obj.items()}
    if isinstance(obj, list):
        return [compact_json(i, max_str_len) for i in obj]
    if isinstance(obj, str):
        s = obj.replace("\n", "\\n").replace("\r", "\\r")
        return s[:max_str_len] + "..." if len(s) > max_str_len else s
    return obj

def dump_log(label, data):
    ts = datetime.now().strftime("%H:%M:%S")
    log_data = data.copy() if isinstance(data, dict) else data
    if isinstance(log_data, dict) and isinstance(log_data.get("tools"), list):
        tools = log_data["tools"]
        names = [t.get("function", {}).get("name", "?") for t in tools if isinstance(t, dict)]
        log_data["tools"] = f"[{len(tools)} tools: {', '.join(names)}]"
    pretty = json.dumps(compact_json(log_data), indent=2, ensure_ascii=False)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"\n{'='*60}\n[{ts}] {label}\n{'='*60}\n{pretty}\n")


# ─── LLM Call ────────────────────────────────────────────────────────

def call_llm(messages, system_prompt, tools):
    url = API_URL.rstrip("/") + "/chat/completions"
    request_body = {
        "model": MODEL,
        "messages": [{"role": "system", "content": system_prompt}] + messages,
        "tools": tools,
    }
    dump_log("REQUEST", request_body)
    body = json.dumps(request_body).encode()
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}",
    })
    with urllib.request.urlopen(req, timeout=120) as r:
        resp = json.loads(r.read())
    dump_log("RESPONSE", resp)
    return resp["choices"][0]["message"]

CHILD_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Run a shell command.",
            "parameters": {
                "type": "object",
                "properties": {"command": {"type": "string"}},
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "limit": {"type": "integer"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write a file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "Edit a file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "old_text": {"type": "string"},
                    "new_text": {"type": "string"},
                },
                "required": ["path", "old_text", "new_text"],
            },
        },
    },
]

PARENT_TOOLS = CHILD_TOOLS + [
    {
        "type": "function",
        "function": {
            "name": "task",
            "description": "Spawn a subagent with fresh context.",
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string"}
                },
                "required": ["prompt"],
            },
        },
    },
]

TOOL_HANDLERS = {
    "bash": lambda **kw: run_bash(kw["command"]),
    "read_file": lambda **kw: run_read(kw["path"], kw.get("limit")),
    "write_file": lambda **kw: run_write(kw["path"], kw["content"]),
    "edit_file": lambda **kw: run_edit(kw["path"], kw["old_text"], kw["new_text"]),
    "task": lambda **kw: run_subagent(kw["prompt"]),
}

def safe_path(p: str) -> Path:
    path = (WORKDIR / p).resolve()
    if not path.is_relative_to(WORKDIR):
        raise ValueError(f"Path escapes workspace: {p}")
    return path


def run_read(path: str, limit: int) -> str:
    try:
        lines = safe_path(path).read_text(encoding="utf-8", errors="ignore").splitlines()
        if limit and limit < len(lines):
            lines = lines[:limit] + [f"... ({len(lines) - limit} more lines)"]
        return "\n".join(lines)[:50000]
    except Exception as e:
        return f"Error: {e}"


def run_write(path: str, content: str) -> str:
    try:
        fp = safe_path(path)
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_text(content)
        return f"Wrote {len(content)} bytes to {path}"
    except Exception as e:
        return f"Error: {e}"


def run_edit(path: str, before: str, after: str) -> str:
    try:
        fp = safe_path(path)
        content = fp.read_text(encoding="utf-8", errors="ignore")
        if before not in content:
            return "Error: old_text not found in file"
        fp.write_text(content.replace(before, after))
        return f"Edited {path}"
    except Exception as e:
        return f"Error: {e}"

def run_bash(command: str) -> str:
    if any(d in command for d in ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"]):
        return "Error: Dangerous command blocked"
    try:
        result = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=120)
        out = (result.stdout + result.stderr).strip()
        return out[:50000] if out else "(no output)"
    except Exception as e:
        return str(e)

def run_subagent(prompt: str) -> str:
    sub_meesage = [{"role": "user", "content": prompt}]
    # at most 30 rounds
    for _ in range(30):
        response = call_llm(sub_meesage, SUBAGENT_SYSTEM, CHILD_TOOLS)
        tool_calls = response.get("tool_calls", [])
        if not tool_calls:
            break
        sub_meesage.append(response)
        for tc in tool_calls:
            name = tc["function"]["name"]
            args = json.loads(tc["function"].get("arguments", "{}"))
            print(f"\n🔧 subagent -> {name}({args})")
            tool = TOOL_HANDLERS.get(name)
            if not tool:
                result = f"Error: Unknown tool {name}"
            else:
                try:
                    result = tool(**args)
                except Exception as e:
                    result = f"Error: {e}"
            print(f"   → {result[:100]}")
            sub_meesage.append({"role": "tool", "tool_call_id": tc["id"], "content": result})  

    # Only return the last message
    return "".join(b.text for b in response.content if hasattr(b, "text")) or "(no summary)" 

def agent_loop(messages, system_prompt):
     while True:
        response = call_llm(messages, system_prompt, PARENT_TOOLS)
        content = response.get("content")
        if content:
            print(f"\n💬 {content}")
        tool_calls = response.get("tool_calls", [])
        if not tool_calls:
            messages.append({"role": "assistant", "content": content})
            return
        messages.append(response)
        for tc in tool_calls:
            name = tc["function"]["name"]
            args = json.loads(tc["function"].get("arguments", "{}"))
            print(f"\n🔧 {name}({args})")
            tool = TOOL_HANDLERS.get(name)
            if not tool:
                result = f"Error: Unknown tool {name}"
            else:
                try:
                    result = tool(**args)
                except Exception as e:
                    result = f"Error: {e}"
            print(f"   → {result[:100]}")
            messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result})  


if __name__ == "__main__":
    messages = []

    while True:
        try:
            user_input = input("❯ ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not user_input:
            continue
        if user_input in ("/q", "exit"):
            break

        messages.append({"role": "user", "content": user_input})
        agent_loop(messages, SYSTEM)

    print("\nBye.")