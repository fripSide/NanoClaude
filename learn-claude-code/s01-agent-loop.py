import json
import os
import subprocess
import urllib.request
from pathlib import Path
from datetime import datetime


SYSTEM_PROMPT = f"You are a coding agent at {os.getcwd()}. Use bash to solve tasks. Act, don't explain."


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
    pretty = json.dumps(compact_json(data), indent=2, ensure_ascii=False)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"\n{'='*60}\n[{ts}] {label}\n{'='*60}\n{pretty}\n")


# ─── LLM Call ────────────────────────────────────────────────────────

def call_llm(messages, system_prompt):
    url = API_URL.rstrip("/") + "/chat/completions"
    request_body = {
        "model": MODEL,
        "messages": [{"role": "system", "content": system_prompt}] + messages,
        "tools": TOOLS,
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

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "run_bash",
            "description": "Run a shell command.",
            "parameters": {
                "type": "object",
                "properties": {"command": {"type": "string"}},
                "required": ["command"],
            },
        },
    }
]


def run_bash(command: str) -> str:
    dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"]
    if any(d in command for d in dangerous):
        return "Error: Dangerous command blocked"
    try:
        result = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=120, check=True)
        out = (result.stdout + result.stderr).strip()
        return out[:50000] if out else "(no output)"
    except subprocess.CalledProcessError as e:
        return f"Command failed with exit code {e.returncode}: {e.stderr}"
    except subprocess.TimeoutExpired:
        return "Command timed out after 120 seconds"
    except Exception as e:
        return f"Unexpected error: {str(e)}"


def agent_loop(messages: list[dict], system_prompt: str):
    while True:
        response = call_llm(messages, system_prompt)
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
            result = run_bash(args["command"])
            print(f"   → {result[:100]}")
            messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result})


if __name__ == "__main__":
    history = []
    while True:
        try:
            query = input("\033[36ms01 >> \033[0m")
        except (EOFError, KeyboardInterrupt):
            break
        if query.strip().lower() in ("q", "exit", ""):
            break
        history.append({"role": "user", "content": query})
        agent_loop(history, SYSTEM_PROMPT)
        response_content = history[-1]["content"]
        if isinstance(response_content, list):
            for block in response_content:
                if hasattr(block, "text"):
                    print(block.text)
        print()