import { stat, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

// ─── Types ───────────────────────────────────────────────────────────

type ToolDef = {
    description: string;
    params: Record<string, string>;
    handler: (args: any) => Promise<any>;
};

type PlanStep = {
    id: number;
    description: string;
    status: "pending" | "running" | "done" | "failed" | "skipped";
    result?: string;
};

type Plan = {
    goal: string;
    analysis: string;
    steps: PlanStep[];
    status: "draft" | "approved" | "executing" | "completed" | "failed";
};

// ─── ANSI Colors ─────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

function separator() {
    return `${DIM}${"─".repeat(Math.min(process.stdout.columns || 80, 80))}${RESET}`;
}

function renderMarkdown(text: string): string {
    return text.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`);
}

// ─── Tool Definitions ───────────────────────────────────────────────

const toolsDef: Record<string, ToolDef> = {
    think: {
        description: "Use this tool to think through a problem step by step. Output your reasoning. This tool has no side effects.",
        params: { thought: "string?" },
        handler: async (args: { thought?: string }) => args.thought || "(thinking)",
    },
    read: {
        description: "Read a file with optional offset and limit (line numbers)",
        params: { path: "string", offset: "number?", limit: "number?" },
        handler: async (args: { path: string, offset?: number, limit?: number }) => {
            const offset = args.offset ?? 0;
            const limit = args.limit;
            const content = await Bun.file(args.path).text();
            const lines = content.split("\n");
            const end = limit ? offset + limit : lines.length;
            const selected = lines.slice(offset, end);
            return selected.map((line, idx) => {
                const lineNum = (offset + idx + 1).toString().padStart(4, " ");
                return `${lineNum}| ${line}`;
            }).join("\n");
        }
    },
    write: {
        description: "Write content to a file (creates or overwrites)",
        params: { path: "string", content: "string" },
        handler: async (args: { path: string, content: string }) => {
            await Bun.write(args.path, args.content);
            return "ok";
        }
    },
    edit: {
        description: "Edit a file by replacing an exact string match",
        params: { path: "string", old: "string", new: "string", all: "boolean?" },
        handler: async (args: { path: string, old: string, new: string, all?: boolean }) => {
            const { path, old: oldContent, new: newContent } = args;
            const all = args.all ?? false;
            const text = await Bun.file(path).text();
            if (!text.includes(oldContent)) return "error: old_string not found";
            const count = text.split(oldContent).length - 1;
            if (!all && count > 1) return `error: old_string appears ${count} times, must be unique (use all=true)`;
            const replacement = all ? text.replaceAll(oldContent, newContent) : text.replace(oldContent, newContent);
            await Bun.write(path, replacement);
            return "ok";
        }
    },
    glob: {
        description: "List files matching a glob pattern in a directory",
        params: { path: "string?", pat: "string" },
        handler: async (args: { path?: string, pat: string }) => {
            const dir = args.path || ".";
            const globPattern = join(dir, args.pat);
            const glob = new Bun.Glob(globPattern);
            const files: { path: string, mtime: number }[] = [];
            for await (const file of glob.scan({ cwd: "." })) {
                try {
                    const s = await stat(file);
                    if (s.isFile()) files.push({ path: file, mtime: s.mtimeMs });
                } catch (e) { /* ignore */ }
            }
            files.sort((a, b) => b.mtime - a.mtime);
            return files.map(f => f.path).join("\n") || "none";
        }
    },
    grep: {
        description: "Search for a regex pattern in files under a directory",
        params: { path: "string?", pat: "string" },
        handler: async (args: { path?: string, pat: string }) => {
            const regex = new RegExp(args.pat);
            const hits: string[] = [];
            const searchDir = args.path || ".";
            const glob = new Bun.Glob("**/*");
            for await (const file of glob.scan({ cwd: searchDir })) {
                try {
                    const fullPath = join(searchDir, file);
                    const s = await stat(fullPath);
                    if (!s.isFile()) continue;
                    const content = await Bun.file(fullPath).text();
                    const lines = content.split("\n");
                    for (let i = 0; i < lines.length; i++) {
                        if (regex.test(lines[i])) {
                            hits.push(`${fullPath}:${i + 1}:${lines[i].trimEnd()}`);
                        }
                    }
                    if (hits.length >= 50) break;
                } catch (e) { /* ignore */ }
            }
            return hits.slice(0, 50).join("\n") || "none";
        }
    },
    bash: {
        description: "Run a bash command with 30s timeout",
        params: { cmd: "string" },
        handler: async (args: { cmd: string }) => {
            const proc = Bun.spawn(["bash", "-c", args.cmd], { stdout: "pipe", stderr: "pipe" });
            let output = "";
            let timer: ReturnType<typeof setTimeout> | null = null;
            try {
                const exitPromise = proc.exited;
                const timeoutPromise = new Promise<void>((_, reject) => {
                    timer = setTimeout(() => { proc.kill(); reject(new Error("Timeout")); }, 30000);
                });
                const readStream = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            output += new TextDecoder().decode(value);
                        }
                    } finally { reader.releaseLock(); }
                };
                await Promise.all([
                    readStream(proc.stdout.getReader()),
                    readStream(proc.stderr.getReader()),
                    Promise.race([exitPromise, timeoutPromise])
                ]);
            } catch (e) {
                output += "\n(timed out after 30s)";
            } finally {
                if (timer) clearTimeout(timer);
            }
            return output.trim() || "(empty)";
        }
    },
};

// ─── Tool Schema Helpers ────────────────────────────────────────────

function mapTypeToZod(typeStr: string) {
    const isOptional = typeStr.endsWith("?");
    const baseType = typeStr.replace("?", "");
    let schema: z.ZodType<any>;
    switch (baseType) {
        case "string": schema = z.string(); break;
        case "number": schema = z.number(); break;
        case "boolean": schema = z.boolean(); break;
        default: schema = z.any();
    }
    return isOptional ? schema.optional() : schema;
}

const toolSchemas = Object.entries(toolsDef).reduce((acc, [name, def]) => {
    const shape: Record<string, z.ZodType<any>> = {};
    for (const [key, type] of Object.entries(def.params)) {
        shape[key] = mapTypeToZod(type);
    }
    acc[name] = z.object(shape);
    return acc;
}, {} as Record<string, z.ZodObject<any>>);

async function runTool(name: string, args: any) {
    const def = toolsDef[name];
    if (!def) throw new Error(`Tool not found: ${name}`);
    const validatedArgs = toolSchemas[name].parse(args);
    return def.handler(validatedArgs);
}

function makeToolsSchema() {
    const result = [];
    for (const [name, def] of Object.entries(toolsDef)) {
        const properties: Record<string, { type: string }> = {};
        const required: string[] = [];
        for (const [paramName, paramType] of Object.entries(def.params)) {
            const isOptional = paramType.endsWith("?");
            const baseType = paramType.replace("?", "");
            const jsonType = baseType === "number" ? "integer" : baseType;
            properties[paramName] = { type: jsonType };
            if (!isOptional) required.push(paramName);
        }
        result.push({
            name,
            description: def.description,
            input_schema: { type: "object", properties, required }
        });
    }
    return result;
}

// ─── API Call ────────────────────────────────────────────────────────

const API_URL = process.env.API_URL;
const MODEL = process.env.MODEL;

const stats = {
    requests: 0,
    tools: {} as Record<string, number>,
    logs: [] as string[]
};

async function callApi(messages: any[], systemPrompt: string, useTools: boolean = true) {
    stats.requests++;

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENROUTER_KEY || process.env.OPENROUTER_API_KEY || ""}`,
    };

    let url = API_URL;
    if (!url) throw new Error("API_URL is undefined");
    if (!url.endsWith("/chat/completions")) {
        url = url.endsWith("/") ? `${url}chat/completions` : `${url}/chat/completions`;
    }

    const tools = useTools ? makeToolsSchema().map(tool => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.input_schema }
    })) : undefined;

    // Convert internal format → OpenAI format
    const convertedMessages: any[] = [
        { role: "system", content: systemPrompt },
    ];

    for (const msg of messages) {
        if (msg.role === "user" && Array.isArray(msg.content) && msg.content[0]?.type === "tool_result") {
            for (const res of msg.content) {
                convertedMessages.push({
                    role: "tool",
                    tool_call_id: res.tool_use_id,
                    content: res.content
                });
            }
        } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
            const textParts = msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
            const toolCalls = msg.content.filter((c: any) => c.type === "tool_use").map((c: any) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.input) }
            }));

            const asstMsg: any = { role: "assistant" };
            if (textParts) asstMsg.content = textParts;
            if (toolCalls.length > 0) asstMsg.tool_calls = toolCalls;
            convertedMessages.push(asstMsg);
        } else {
            convertedMessages.push({
                role: msg.role,
                content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
            });
        }
    }

    const body: any = { model: MODEL, messages: convertedMessages };
    if (tools) body.tools = tools;

    await appendFile("api_responses.log", `[Request] ${new Date().toISOString()}\n${JSON.stringify(body)}\n\n`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    try {
        const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`API Error: ${response.status} ${response.statusText} - ${await response.text()}`);
        }

        const data = await response.json();
        await appendFile("api_responses.log", `[Response] ${new Date().toISOString()}\n${JSON.stringify(data)}\n\n---\n\n`);

        const choice = data.choices[0];
        const msg = choice.message;
        const content: any[] = [];

        if (msg.content) {
            content.push({ type: "text", text: msg.content });
        }
        if (msg.tool_calls) {
            for (const call of msg.tool_calls) {
                content.push({
                    type: "tool_use",
                    id: call.id,
                    name: call.function.name,
                    input: JSON.parse(call.function.arguments)
                });
            }
        }
        return { content };
    } finally {
        clearTimeout(timeout);
    }
}

// ─── Robust JSON Extraction ─────────────────────────────────────────

function extractJson(text: string): any {
    let s = text.trim();

    // Strip <think>...</think> blocks (some models emit these)
    s = s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    // Try raw parse first
    try { return JSON.parse(s); } catch (_) { }

    // Try extracting from markdown fences
    const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
        try { return JSON.parse(fenceMatch[1].trim()); } catch (_) { }
    }

    // Try finding the first { ... } block
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start !== -1 && end > start) {
        const candidate = s.slice(start, end + 1);
        try { return JSON.parse(candidate); } catch (_) { }

        // Last resort: strip single-line comments then try again
        const cleaned = candidate.replace(/\/\/.*$/gm, "").replace(/,\s*([}\]])/g, "$1");
        try { return JSON.parse(cleaned); } catch (_) { }
    }

    throw new Error("Could not extract valid JSON from LLM response");
}

// ─── Planning Phase ──────────────────────────────────────────────────

const PLANNING_SYSTEM_PROMPT = `You are a planning agent. Analyze user tasks and create structured execution plans.

Working directory: ${process.cwd()}

Respond with a JSON plan ONLY (no markdown fences, no extra text):
{
  "goal": "one-sentence goal",
  "analysis": "brief analysis",
  "steps": [
    { "id": 1, "description": "what this step does" },
    { "id": 2, "description": "what this step does" }
  ]
}

Steps are high-level descriptions of WHAT to do (not HOW). During execution, an AI will use tools to carry out each step.

Available tools for execution: read, write, edit, glob, grep, bash, think.

Rules:
1. Break the task into concrete, ordered steps
2. Each step description should be clear and actionable
3. Keep plans concise — prefer fewer, meaningful steps
4. Steps that depend on earlier results should say so (e.g. "Based on the files found, read the main source file")
5. Output ONLY valid JSON, no comments, no extra text`;

const EXECUTION_SYSTEM_PROMPT = `You are an execution agent. You execute plan steps one at a time by calling tools.
Working directory: ${process.cwd()}

You will receive:
1. The full plan with step descriptions
2. Results from previously completed steps (may be summarized)
3. The current step to execute

Your job: Call the appropriate tool(s) to accomplish the current step's description. Use information from previous step results to inform your tool calls.

Rules:
- Focus only on the current step
- Use previous results to make informed decisions (e.g., if step 1 listed files, use those file names in step 2)
- You may call multiple tools if needed to complete one step, but be efficient — avoid reading very large files in full
- When writing files, include REAL content based on what you've learned from previous steps, NOT placeholder text
- Prefer targeted reads (with offset/limit) over full file reads for large files
- Keep tool calls focused and minimal`;

async function generatePlan(userInput: string): Promise<Plan | null> {
    console.log(`\n${MAGENTA}⏺ Planning${RESET} ${DIM}Analyzing task...${RESET}`);

    const messages = [{ role: "user", content: userInput }];

    try {
        const response = await callApi(messages, PLANNING_SYSTEM_PROMPT, false);
        const textBlock = response.content.find((b: any) => b.type === "text");
        if (!textBlock) {
            console.log(`${RED}⏺ Error: No response from planning phase${RESET}`);
            return null;
        }

        const parsed = extractJson(textBlock.text);

        const plan: Plan = {
            goal: parsed.goal,
            analysis: parsed.analysis,
            steps: parsed.steps.map((s: any) => ({
                id: s.id,
                description: s.description,
                status: "pending" as const,
            })),
            status: "draft",
        };

        return plan;
    } catch (e: any) {
        console.log(`${RED}⏺ Planning error: ${e.message}${RESET}`);
        return null;
    }
}

// ─── Plan Display ────────────────────────────────────────────────────

function displayPlan(plan: Plan) {
    console.log(`\n${separator()}`);
    console.log(`${BOLD}${MAGENTA}📋 Plan${RESET}`);
    console.log(`${BOLD}Goal:${RESET} ${plan.goal}`);
    console.log(`${BOLD}Analysis:${RESET} ${plan.analysis}`);
    console.log();

    for (const step of plan.steps) {
        const statusIcon = getStatusIcon(step.status);
        console.log(`  ${statusIcon} ${BOLD}Step ${step.id}${RESET}: ${step.description}`);
    }

    console.log(`\n${separator()}`);
}

function getStatusIcon(status: string): string {
    switch (status) {
        case "pending": return `${DIM}○${RESET}`;
        case "running": return `${YELLOW}◉${RESET}`;
        case "done": return `${GREEN}✔${RESET}`;
        case "failed": return `${RED}✖${RESET}`;
        case "skipped": return `${DIM}⊘${RESET}`;
        default: return "?";
    }
}

function displayStepProgress(plan: Plan) {
    const total = plan.steps.length;
    const done = plan.steps.filter(s => s.status === "done").length;
    const failed = plan.steps.filter(s => s.status === "failed").length;

    const bar = plan.steps.map(s => {
        switch (s.status) {
            case "done": return `${GREEN}█${RESET}`;
            case "failed": return `${RED}█${RESET}`;
            case "running": return `${YELLOW}█${RESET}`;
            case "skipped": return `${DIM}░${RESET}`;
            default: return `${DIM}░${RESET}`;
        }
    }).join("");

    console.log(`  ${bar} ${done}/${total}${failed > 0 ? ` (${RED}${failed} failed${RESET})` : ""}`);
}

// ─── Execution Phase (LLM-driven) ───────────────────────────────────

const MAX_TOOL_RESULT_CHARS = 3000;   // max chars per tool result sent back to LLM
const MAX_STEP_RESULT_CHARS = 1500;   // max chars stored per completed step for context
const MAX_CONTEXT_BUDGET = 6000;      // total chars budget for "previous results" section
const MAX_STEP_MSG_CHARS = 8000;      // max total chars in within-step messages before compaction

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    const half = Math.floor(max / 2) - 20;
    return s.slice(0, half) + `\n\n... (${s.length - max} chars truncated) ...\n\n` + s.slice(-half);
}

function buildPreviousContext(completedResults: { stepId: number, description: string, result: string }[]): string {
    if (completedResults.length === 0) return "";

    // Build context within budget, prioritizing most recent steps
    let context = "";
    const parts: string[] = [];

    for (let i = completedResults.length - 1; i >= 0; i--) {
        const r = completedResults[i];
        const part = `--- Step ${r.stepId}: ${r.description} ---\n${r.result}\n`;
        if (context.length + part.length > MAX_CONTEXT_BUDGET && parts.length > 0) {
            // Add a note about skipped older steps
            parts.push(`(${i + 1} earlier step(s) omitted for brevity)`);
            break;
        }
        parts.push(part);
        context += part;
    }

    return `\n\nResults from previous steps:\n${parts.reverse().join("\n")}`;
}

function compactStepMessages(messages: any[]) {
    // Estimate total content size
    let totalSize = 0;
    for (const msg of messages) {
        if (typeof msg.content === "string") {
            totalSize += msg.content.length;
        } else if (Array.isArray(msg.content)) {
            for (const item of msg.content) {
                totalSize += JSON.stringify(item).length;
            }
        }
    }

    if (totalSize <= MAX_STEP_MSG_CHARS) return;

    // Compact: truncate old tool_result messages (keep the most recent 2 messages intact)
    const keepIntact = 2;
    for (let i = 0; i < messages.length - keepIntact; i++) {
        const msg = messages[i];
        if (msg.role === "user" && Array.isArray(msg.content)) {
            for (let j = 0; j < msg.content.length; j++) {
                const item = msg.content[j];
                if (item.type === "tool_result" && item.content && item.content.length > 500) {
                    msg.content[j] = {
                        ...item,
                        content: item.content.slice(0, 250) + "\n...(compacted)...\n" + item.content.slice(-200)
                    };
                }
            }
        }
        // Also compact assistant text content in older messages
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (let j = 0; j < msg.content.length; j++) {
                const item = msg.content[j];
                if (item.type === "text" && item.text && item.text.length > 500) {
                    msg.content[j] = {
                        ...item,
                        text: item.text.slice(0, 250) + "\n...(compacted)...\n" + item.text.slice(-200)
                    };
                }
            }
        }
    }
}

async function executePlan(plan: Plan): Promise<void> {
    plan.status = "executing";
    console.log(`\n${BOLD}${GREEN}▶ Executing Plan${RESET}\n`);

    const completedResults: { stepId: number, description: string, result: string }[] = [];

    for (const step of plan.steps) {
        step.status = "running";
        displayStepProgress(plan);

        console.log(`\n${YELLOW}◉ Step ${step.id}${RESET}: ${step.description}`);

        const previousContext = buildPreviousContext(completedResults);

        const planOverview = plan.steps.map(s =>
            `  ${s.status === "done" ? "✔" : s.id === step.id ? "→" : "○"} Step ${s.id}: ${s.description}`
        ).join("\n");

        const executionPrompt = `Plan:\n${planOverview}${previousContext}\n\nNow execute Step ${step.id}: "${step.description}"\n\nCall the appropriate tool(s) to accomplish this step. Use information from previous step results.`;

        // Use the LLM with tools to execute this step via an agentic loop
        const stepMessages: any[] = [{ role: "user", content: executionPrompt }];
        let stepResult = "";

        try {
            let maxTurns = 5; // safety limit for one step
            while (maxTurns-- > 0) {
                // Compact old messages to prevent within-step context overflow
                compactStepMessages(stepMessages);
                const response = await callApi(stepMessages, EXECUTION_SYSTEM_PROMPT, true);
                const contentBlocks = response.content || [];
                const toolResults: any[] = [];

                for (const block of contentBlocks) {
                    if (block.type === "text") {
                        console.log(`  ${DIM}${renderMarkdown(block.text.split("\n")[0].slice(0, 80))}${RESET}`);
                        stepResult += block.text + "\n";
                    }

                    if (block.type === "tool_use") {
                        const toolName = block.name;
                        const toolArgs = block.input;
                        const argPreview = JSON.stringify(Object.values(toolArgs)[0] || "").slice(0, 50);

                        stats.tools[toolName] = (stats.tools[toolName] || 0) + 1;
                        console.log(`  ${GREEN}⏺ ${toolName}${RESET}(${DIM}${argPreview}${RESET})`);

                        let result;
                        try {
                            result = await runTool(toolName, toolArgs);
                        } catch (err: any) {
                            result = `error: ${err.message}`;
                        }

                        const resultStr = String(result);
                        // Truncate large results before sending back to LLM
                        const truncatedResult = truncate(resultStr, MAX_TOOL_RESULT_CHARS);
                        stepResult += `[${toolName}] ${truncatedResult}\n`;

                        // Display result preview
                        const resultLines = resultStr.split("\n");
                        let preview = resultLines[0]?.slice(0, 60) || "";
                        if (resultLines.length > 1) preview += ` ... +${resultLines.length - 1} lines`;
                        console.log(`    ${DIM}⎿ ${preview}${RESET}`);

                        // Log
                        const summary = `${new Date().toISOString()} | PLAN_EXEC | step=${step.id} | ${toolName} | ${resultStr.slice(0, 100).replace(/\n/g, "\\n")}`;
                        stats.logs.push(summary);
                        await appendFile("actions.log", summary + "\n");

                        toolResults.push({
                            type: "tool_result",
                            tool_use_id: block.id,
                            content: truncatedResult,
                        });
                    }
                }

                stepMessages.push({ role: "assistant", content: contentBlocks });

                if (toolResults.length === 0) {
                    // LLM is done with this step (no more tool calls)
                    break;
                }
                stepMessages.push({ role: "user", content: toolResults });
            }

            step.status = "done";
            step.result = stepResult.trim();
            // Store a truncated version for context passed to subsequent steps
            completedResults.push({
                stepId: step.id,
                description: step.description,
                result: truncate(step.result, MAX_STEP_RESULT_CHARS)
            });
            console.log(`  ${GREEN}✔ Step ${step.id} done${RESET}`);

        } catch (err: any) {
            step.status = "failed";
            step.result = `error: ${err.message}`;
            console.log(`  ${RED}✖ Failed: ${err.message}${RESET}`);

            const summary = `${new Date().toISOString()} | PLAN_EXEC | step=${step.id} | ERROR: ${err.message}`;
            stats.logs.push(summary);
            await appendFile("actions.log", summary + "\n");

            // Ask user whether to continue
            process.stdout.write(`\n  ${YELLOW}Continue with remaining steps? (y/n)${RESET} `);
            const answer = prompt("");
            if (answer?.trim().toLowerCase() !== "y") {
                plan.steps.filter(s => s.status === "pending").forEach(s => s.status = "skipped");
                plan.status = "failed";
                return;
            }
        }
    }

    plan.status = plan.steps.some(s => s.status === "failed") ? "failed" : "completed";
}

// ─── Summary Report ──────────────────────────────────────────────────

function displaySummary(plan: Plan) {
    console.log(`\n${separator()}`);
    const icon = plan.status === "completed" ? `${GREEN}✔` : `${RED}✖`;
    console.log(`${BOLD}${icon} Plan ${plan.status === "completed" ? "Completed" : "Failed"}${RESET}`);
    console.log();

    for (const step of plan.steps) {
        const statusIcon = getStatusIcon(step.status);
        console.log(`  ${statusIcon} Step ${step.id}: ${step.description}`);
        if (step.result) {
            const preview = step.result.split("\n")[0]?.slice(0, 60) || "";
            console.log(`     ${DIM}⎿ ${preview}${step.result.length > 60 ? "..." : ""}${RESET}`);
        }
    }

    displayStepProgress(plan);
    console.log(separator());
}

// ─── Main Loop ───────────────────────────────────────────────────────

async function main() {
    console.log(`${BOLD}${MAGENTA}planning-agent${RESET} | ${DIM}${MODEL} | ${process.cwd()}${RESET}`);
    console.log(`${DIM}Commands: /q quit, /c clear, /stats [file]${RESET}\n`);
    console.log(separator());

    while (true) {
        process.stdout.write(`${BOLD}${BLUE}❯${RESET} `);
        const userInput = prompt("");
        console.log(separator());

        if (!userInput) continue;
        const input = userInput.trim();

        // Log
        const userLog = `${new Date().toISOString()} | USER | ${input}`;
        stats.logs.push(userLog);
        await appendFile("actions.log", userLog + "\n");

        if (["/q", "exit"].includes(input)) break;

        if (input === "/c") {
            console.log(`${GREEN}⏺ Cleared${RESET}`);
            continue;
        }

        if (input.startsWith("/stats")) {
            const path = input.split(" ")[1];
            const content = [
                `Total Requests: ${stats.requests}`,
                `Tool Usage:`,
                ...Object.entries(stats.tools).map(([n, c]) => `  - ${n}: ${c}`),
                `Logs:`,
                ...stats.logs
            ].join("\n");

            if (path) {
                await Bun.write(path, content);
                console.log(`${GREEN}⏺ Stats saved to ${path}${RESET}`);
            } else {
                console.log(`${CYAN}Stats:${RESET}\n${content}`);
            }
            continue;
        }

        try {
            // ─── Phase 1: Generate Plan ──────────────────────────
            const plan = await generatePlan(input);
            if (!plan) {
                console.log(`${RED}⏺ Could not generate a plan. Try rephrasing.${RESET}`);
                continue;
            }

            // ─── Display Plan for Approval ───────────────────────
            displayPlan(plan);

            // ─── Phase 2: User Approval ──────────────────────────
            process.stdout.write(`${BOLD}${YELLOW}Approve plan? (y)es / (n)o / (e)dit${RESET} `);
            const approval = prompt("");
            const choice = approval?.trim().toLowerCase();

            if (choice === "n" || choice === "no") {
                console.log(`${DIM}⏺ Plan rejected${RESET}`);
                continue;
            }

            if (choice === "e" || choice === "edit") {
                process.stdout.write(`${CYAN}Describe changes:${RESET} `);
                const edits = prompt("");
                if (edits?.trim()) {
                    const revisedPlan = await generatePlan(`${input}\n\nRevise the plan with these changes: ${edits.trim()}`);
                    if (revisedPlan) {
                        displayPlan(revisedPlan);
                        process.stdout.write(`${BOLD}${YELLOW}Approve revised plan? (y/n)${RESET} `);
                        const reApproval = prompt("");
                        if (reApproval?.trim().toLowerCase() !== "y" && reApproval?.trim().toLowerCase() !== "yes") {
                            console.log(`${DIM}⏺ Plan rejected${RESET}`);
                            continue;
                        }
                        revisedPlan.status = "approved";
                        await executePlan(revisedPlan);
                        displaySummary(revisedPlan);
                        continue;
                    }
                }
                console.log(`${DIM}⏺ No changes made${RESET}`);
                continue;
            }

            // Default: approve
            plan.status = "approved";

            // ─── Phase 3: Execute Plan ───────────────────────────
            await executePlan(plan);
            displaySummary(plan);

        } catch (err: any) {
            console.log(`${RED}⏺ Error: ${err.message}${RESET}`);
        }

        console.log();
    }
}

// ─── Entry Point ─────────────────────────────────────────────────────

if (import.meta.main) {
    main().catch(console.error);
}
