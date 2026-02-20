#!/usr/bin/env python3
"""Minimal agent loop — as close to the pseudocode as possible."""

import json, os, subprocess, re, glob as glob_mod
import urllib.request
from pathlib import Path

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
MODEL   = os.environ.get("MODEL", "qwen3-max")

# ─── Tools ───────────────────────────────────────────────────────────

TOOLS = {
    "read": {
        "desc": "Read a file",
        "params": {"path": "string"},
        "fn": lambda path: Path(path).read_text(),
    },
    "write": {
        "desc": "Write a file",
        "params": {"path": "string", "content": "string"},
        "fn": lambda path, content: (Path(path).parent.mkdir(parents=True, exist_ok=True), Path(path).write_text(content), "ok")[-1],
    },
    "edit": {
        "desc": "Replace old string with new in a file",
        "params": {"path": "string", "old": "string", "new": "string"},
        "fn": lambda path, old, new: Path(path).write_text(Path(path).read_text().replace(old, new)) or "ok",
    },
    "bash": {
        "desc": "Run a shell command (30s timeout)",
        "params": {"cmd": "string"},
        "fn": lambda cmd: (lambda r: (r.stdout + r.stderr).strip() or "(empty)")(subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30)),
    },
}

def execute_tool(name, args):
    try:
        return str(TOOLS[name]["fn"](**args))
    except Exception as e:
        return f"error: {e}"

def tools_schema():
    return [{"type": "function", "function": {
        "name": n,
        "description": t["desc"],
        "parameters": {
            "type": "object",
            "properties": {k: {"type": v} for k, v in t["params"].items()},
            "required": list(t["params"].keys()),
        },
    }} for n, t in TOOLS.items()]

# ─── LLM Call ────────────────────────────────────────────────────────

def call_llm(messages, system_prompt):
    url = API_URL.rstrip("/") + "/chat/completions"
    body = json.dumps({
        "model": MODEL,
        "messages": [{"role": "system", "content": system_prompt}] + messages,
        "tools": tools_schema(),
    }).encode()
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}",
    })
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())["choices"][0]["message"]

# ─── Agent Loop ──────────────────────────────────────────────────────

def agent_loop(messages, system_prompt):
    """Call LLM in a loop, executing tool calls until the model stops."""
    while True:
        response = call_llm(messages, system_prompt)

        if response.get("content"):
            print(f"\n💬 {response['content']}")

        tool_calls = response.get("tool_calls", [])
        if not tool_calls:
            messages.append({"role": "assistant", "content": response.get("content", "")})
            return

        messages.append(response)  # assistant msg with tool_calls

        for tc in tool_calls:
            name = tc["function"]["name"]
            args = json.loads(tc["function"].get("arguments", "{}"))
            print(f"\n🔧 {name}({args})")
            result = execute_tool(name, args)
            print(f"   → {result[:100]}")
            messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result})

# ─── Main ────────────────────────────────────────────────────────────

def main():
    print(f"agent-loop | {MODEL}\n")
    messages = []
    system_prompt = f"Concise coding assistant. cwd: {os.getcwd()}"

    while True:
        try:
            user_input = input("❯ ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not user_input:
            continue
        if user_input in ("/q", "exit"):
            break
        if user_input == "/c":
            messages = []
            print("Cleared.")
            continue

        messages.append({"role": "user", "content": user_input})
        agent_loop(messages, system_prompt)
        print()

if __name__ == "__main__":
    main()
