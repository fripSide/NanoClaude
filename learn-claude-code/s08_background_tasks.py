import json
import os
import re
import subprocess
import sys
import threading
import uuid
import urllib.request
from pathlib import Path
from datetime import datetime
from dotenv import load_dotenv

WORKDIR = Path.cwd()


SKILLS_DIR = WORKDIR / "skills"

# ─── Config ──────────────────────────────────────────────────────────

load_dotenv()
API_URL = os.environ.get("API_URL", "")
API_KEY = os.environ.get("OPENROUTER_KEY", "")
MODEL = os.environ.get("MODEL", "qwen3-max")


SYSTEM = f"You are a coding agent at {WORKDIR}. Use background_run for long-running commands."

# -- BackgroundManager: threaded execution + notification queue --
class BackgroundManager:
    def __init__(self):
        self.tasks = {}  # task_id -> {status, result, command}
        self._notification_queue = []  # completed task results
        self._lock = threading.Lock()

    def run(self, command: str) -> str:
        """Start a background thread, return task_id immediately."""
        task_id = str(uuid.uuid4())[:8]
        self.tasks[task_id] = {"status": "running", "result": None, "command": command}
        thread = threading.Thread(
            target=self._execute, args=(task_id, command), daemon=True
        )
        thread.start()
        return f"Background task {task_id} started: {command[:80]}"


    def _execute(self, task_id: str, command: str):
        """Worker thread: run command, update status, queue notification."""
        try:
            result = run_bash(command)
            status = "completed"
        except Exception as e:
            result = f"Error: {e}"
            status = "failed"
        with self._lock:
            self.tasks[task_id]["status"] = status
            self.tasks[task_id]["result"] = result
            self._notification_queue.append({
                "task_id": task_id,
                "status": status,
                "command": command,
                "result": result,
            })

    def check(self, task_id: str = None) -> str:
        """Return status of one or all tasks."""
        if task_id:
            task = self.tasks.get(task_id)
            if not task:
                return f"Task {task_id} not found"
            return f"Task {task_id} ({task['status']}): {task['command'][:80]}..."
        lines = []
        for tid, t in self.tasks.items():
            lines.append(f"Task {tid} ({t['status']}): {t['command'][:80]}...")
        return "\n".join(lines) if lines else "No background tasks"

    def drain_notifications(self):
        """Return all completed/failed notifications and clear queue."""
        with self._lock:
            items = list(self._notification_queue)
            self._notification_queue = []
            return items

# ─── Logging ─────────────────────────────────────────────────────────

LOG_FILE = Path(__file__).resolve().parent / "agent_debug.log"
CONV_LOG_FILE = Path(__file__).resolve().parent / "agent_conv.log"
if os.path.exists(LOG_FILE):
    os.remove(LOG_FILE)
if os.path.exists(CONV_LOG_FILE):
    os.remove(CONV_LOG_FILE)

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

def dump_conv_log(messages, system_prompt=""):
    """Write conversation log, splitting turns with ----."""
    with open(CONV_LOG_FILE, "a", encoding="utf-8") as f:
        if system_prompt:
            f.write(f"[system]\n{system_prompt}\n")
        for msg in messages:
            role = msg.get("role", "unknown")
            if role == "system":
                continue
            if role == "user":
                f.write(f"\n----\n[user]\n{msg.get('content', '')}\n")
            elif role == "tool":
                tool_id = msg.get("tool_call_id", "")
                content = msg.get("content", "")
                f.write(f"[tool] {tool_id}\n{content}\n")
            elif role == "assistant":
                content = (msg.get("content", "") or "").replace("\n\n", "\n")
                f.write(f"[assistant]\n{content}\n")
                for tc in msg.get("tool_calls", []):
                    name = tc.get("function", {}).get("name", "?")
                    args = tc.get("function", {}).get("arguments", "")
                    f.write(f"[tool_call] {name}\n{args}\n")
            else:
                f.write(f"[{role}]\n{msg.get('content', '')}\n")


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

TOOLS = [
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
    {
        "type": "function",
        "function": {
            "name": "background_run",
            "description": "Run command in background thread. Returns task_id immediately.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_background",
            "description": "Check background task status. Omit task_id to list all.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {"type": "string"},
                },
            },
        },
    },
]


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

BG = BackgroundManager()

TOOL_HANDLERS = {
    "bash": lambda **kw: run_bash(kw["command"]),
    "read_file": lambda **kw: run_read(kw["path"], kw.get("limit")),
    "write_file": lambda **kw: run_write(kw["path"], kw["content"]),
    "edit_file": lambda **kw: run_edit(kw["path"], kw["old_text"], kw["new_text"]),
    "background_run": lambda **kw: BG.run(kw["command"]),
    "check_background": lambda **kw: BG.check(kw.get("task_id"))
}

def agent_loop(messages, system_prompt):
     while True:

        # drain background notifications
        notifs = BG.drain_notifications()
        if notifs:
            notif_text = "\n".join(f"[bg:{t['task_id']}] {t['status']}: {t['result']}" for t in notifs)
            messages.append({"role": "user", "content": f"<background-results>\n{notif_text}\n</background-results>"})
            messages.append({"role": "assistant", "content": "Noted background results."})

        response = call_llm(messages, system_prompt, TOOLS)
        content = response.get("content")
        if content:
            print(f"\n💬 {content}")
        tool_calls = response.get("tool_calls", [])
        if not tool_calls:
            messages.append({"role": "assistant", "content": content})
            dump_conv_log(messages, system_prompt)
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
        dump_conv_log(messages, system_prompt)


if __name__ == "__main__":
    history = []

    while True:
        try:
            user_input = input("❯ ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not user_input:
            continue
        if user_input in ("/q", "exit"):
            break

        history.append({"role": "user", "content": user_input})
        agent_loop(history, SYSTEM)

    print("\nBye.")