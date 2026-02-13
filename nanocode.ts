import { readdir, stat, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

type ToolDef = {
    description: string;
    params: Record<string, string>;
    handler: (args: any) => Promise<any>;
};

const toolsDef: Record<string, ToolDef> = {
    read: {
        description: "read a file with optional offset and limit",
        params: {
            path: "string",
            offset: "number?",
            limit: "number?"
        },
        handler: async (args: { path: string, offset?: number, limit?: number }) => {
            const { path } = args;
            const offset = args.offset ?? 0;
            const limit = args.limit;

            const content = await Bun.file(path).text();
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
        description: "write a file",
        params: {
            path: "string",
            content: "string"
        },
        handler: async (args: { path: string, content: string }) => {
            await Bun.write(args.path, args.content);
            return "ok";
        }
    },
    edit: {
        description: "edit a file by replacing a string",
        params: {
            path: "string",
            old: "string",
            new: "string",
            all: "boolean?"
        },
        handler: async (args: { path: string, old: string, new: string, all?: boolean }) => {
            const path = args.path;
            const oldContent = args.old;
            const newContent = args.new;
            const all = args.all ?? false;

            const file = Bun.file(path);
            const text = await file.text();

            if (!text.includes(oldContent)) {
                return "error: old_string not found";
            }

            const count = text.split(oldContent).length - 1;
            if (!all && count > 1) {
                return `error: old_string appears ${count} times, must be unique (use all=true)`;
            }

            const replacement = all
                ? text.replaceAll(oldContent, newContent)
                : text.replace(oldContent, newContent);

            await Bun.write(path, replacement);
            return "ok";
        }
    },
    glob: {
        description: "glob a directory",
        params: {
            path: "string?",
            pat: "string"
        },
        handler: async (args: { path?: string, pat: string }) => {
            const dir = args.path || ".";
            const pattern = args.pat;

            const globPattern = join(dir, pattern);
            const glob = new Bun.Glob(globPattern);

            const files: { path: string, mtime: number }[] = [];

            for await (const file of glob.scan({ cwd: "." })) {
                try {
                    const stats = await stat(file);
                    if (stats.isFile()) {
                        files.push({ path: file, mtime: stats.mtimeMs });
                    }
                } catch (e) {
                    // ignore
                }
            }

            files.sort((a, b) => b.mtime - a.mtime);

            return files.map(f => f.path).join("\n") || "none";
        }
    },
    grep: {
        description: "grep files in a directory",
        params: {
            path: "string?",
            pat: "string"
        },
        handler: async (args: { path?: string, pat: string }) => {
            const pattern = args.pat;
            const regex = new RegExp(pattern);
            const hits: string[] = [];
            const searchDir = args.path || ".";
            const glob = new Bun.Glob("**/*");

            for await (const file of glob.scan({ cwd: searchDir })) {
                try {
                    const fullPath = join(searchDir, file);
                    const stats = await stat(fullPath);
                    if (!stats.isFile()) continue;

                    const content = await Bun.file(fullPath).text();
                    const lines = content.split("\n");

                    for (let i = 0; i < lines.length; i++) {
                        if (regex.test(lines[i])) {
                            hits.push(`${fullPath}:${i + 1}:${lines[i].trimEnd()}`);
                        }
                    }
                    if (hits.length >= 50) break;
                } catch (e) {
                    // ignore
                }
            }

            return hits.slice(0, 50).join("\n") || "none";
        }
    },
    bash: {
        description: "run a bash command with timeout",
        params: {
            cmd: "string"
        },
        handler: async (args: { cmd: string }) => {
            const command = args.cmd;
            const proc = Bun.spawn(["bash", "-c", command], {
                stdout: "pipe",
                stderr: "pipe",
            });

            const timeoutSignal = AbortSignal.timeout(30000);
            let output = "";
            let timer: ReturnType<typeof setTimeout> | null = null;

            try {
                const exitPromise = proc.exited;
                const timeoutPromise = new Promise<void>((_, reject) => {
                    timer = setTimeout(() => {
                        proc.kill();
                        reject(new Error("Timeout"));
                    }, 30000);
                });

                const readStream = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            const chunk = new TextDecoder().decode(value);
                            output += chunk;
                        }
                    } finally {
                        reader.releaseLock();
                    }
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

    if (isOptional) {
        schema = schema.optional();
    }
    return schema;
}

const toolSchemas = Object.entries(toolsDef).reduce((acc, [name, def]) => {
    const shape: Record<string, z.ZodType<any>> = {};
    for (const [key, type] of Object.entries(def.params)) {
        shape[key] = mapTypeToZod(type);
    }
    acc[name] = z.object(shape);
    return acc;
}, {} as Record<string, z.ZodObject<any>>);

export async function runTool(name: string, args: any) {
    const def = toolsDef[name];
    if (!def) {
        throw new Error(`Tool not found: ${name}`);
    }

    const schema = toolSchemas[name];
    const validatedArgs = schema.parse(args);
    return def.handler(validatedArgs);
}

export function makeSchema() {
    const result = [];
    for (const [name, def] of Object.entries(toolsDef)) {
        const properties: Record<string, { type: string }> = {};
        const required: string[] = [];

        for (const [paramName, paramType] of Object.entries(def.params)) {
            const isOptional = paramType.endsWith("?");
            const baseType = paramType.replace("?", "");

            // Map TypeScript types to JSON schema types
            const jsonType = baseType === "number" ? "integer" : baseType;

            properties[paramName] = { type: jsonType };
            if (!isOptional) {
                required.push(paramName);
            }
        }

        result.push({
            name,
            description: def.description,
            input_schema: {
                type: "object",
                properties,
                required
            }
        });
    }
    return result;
}


// --- Agentic Loop Implementation ---

import { createInterface } from "node:readline/promises";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const API_URL = process.env.API_URL;
const MODEL = process.env.MODEL;

// ANSI colors
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

function renderMarkdown(text: string): string {
    return text.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`);
}

function separator() {
    return `${DIM}${"─".repeat(Math.min(process.stdout.columns || 80, 80))}${RESET}`;
}


const stats = {
    requests: 0,
    tools: {} as Record<string, number>,
    logs: [] as string[]
};

async function callApi(messages: any[], systemPrompt: string) {
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

    const tools = makeSchema().map(tool => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema
        }
    }));

    // Convert internal message format to OpenAI format
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
                function: {
                    name: c.name,
                    arguments: JSON.stringify(c.input)
                }
            }));

            const asstMsg: any = { role: "assistant" };
            if (textParts) asstMsg.content = textParts;
            if (toolCalls.length > 0) asstMsg.tool_calls = toolCalls;
            convertedMessages.push(asstMsg);
        } else {
            convertedMessages.push({ role: msg.role, content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
        }
    }

    const body = {
        model: MODEL,
        messages: convertedMessages,
        tools,
    };

    await appendFile("api_responses.log", `[Request] ${new Date().toISOString()}\n${JSON.stringify(body)}\n\n`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

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

        // Convert OpenAI response to internal format
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

async function main() {
    console.log(`${BOLD}nanocode${RESET} | ${DIM}${MODEL} | ${process.cwd()}${RESET}\n`);

    let messages: any[] = [];
    const systemPrompt = `Concise coding assistant. cwd: ${process.cwd()}`;
    // Helper for reading input
    console.log(separator());

    while (true) {
        process.stdout.write(`${BOLD}${BLUE}❯${RESET} `);
        // prompt() is a global in Bun (synchronous)
        const userInput = prompt("");
        console.log(separator());

        if (!userInput) continue;

        const input = userInput.trim();

        // Log user input
        const userSummary = `${new Date().toISOString()} | USER | ${input}`;
        stats.logs.push(userSummary);
        await appendFile("actions.log", userSummary + "\n");

        if (["/q", "exit"].includes(input)) {
            break;
        }

        if (input.startsWith("/stats")) {
            const parts = input.split(" ");
            const path = parts[1];
            const content = [
                `Total Requests: ${stats.requests}`,
                `Tool Usage:`,
                ...Object.entries(stats.tools).map(([name, count]) => `  - ${name}: ${count}`),
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

        if (input === "/c") {
            messages = [];
            console.log(`${GREEN}⏺ Cleared conversation${RESET}`);
            continue;
        }

        messages.push({ role: "user", content: input });
        // console.error(`DEBUG: Processing input: "${input}"`);

        try {
            // Agentic loop
            while (true) {
                // console.error("DEBUG: Calling API...");
                const response: any = await callApi(messages, systemPrompt);
                // console.error("DEBUG: API Response received");

                const contentBlocks = response.content || [];
                const toolResults: any[] = [];

                for (const block of contentBlocks) {
                    if (block.type === "text") {
                        console.log(`\n${CYAN}⏺${RESET} ${renderMarkdown(block.text)}`);
                        // Log assistant text
                        const asstSummary = `${new Date().toISOString()} | ASSISTANT | ${block.text.replace(/\n/g, "\\n")}`;
                        stats.logs.push(asstSummary);
                        await appendFile("actions.log", asstSummary + "\n");
                    }

                    if (block.type === "tool_use") {
                        const toolName = block.name;
                        const toolArgs = block.input;
                        const argPreview = JSON.stringify(Object.values(toolArgs)[0] || "").slice(0, 50);

                        stats.tools[toolName] = (stats.tools[toolName] || 0) + 1;

                        console.log(`\n${GREEN}⏺ ${toolName.charAt(0).toUpperCase() + toolName.slice(1)}${RESET}(${DIM}${argPreview}${RESET})`);
                        // console.error(`DEBUG: Running tool ${toolName}...`);

                        let result;
                        try {
                            result = await runTool(toolName, toolArgs);
                        } catch (err: any) {
                            result = `error: ${err.message}`;
                        }

                        // Log action summary
                        const summary = `${new Date().toISOString()} | ${toolName} | ${JSON.stringify(toolArgs)} | ${String(result).slice(0, 100).replace(/\n/g, "\\n")}`;
                        stats.logs.push(summary); // Store in memory for /stats
                        await appendFile("actions.log", summary + "\n");

                        // Formatting result preview
                        const resultStr = String(result);
                        const resultLines = resultStr.split("\n");
                        let preview = resultLines[0]?.slice(0, 60) || "";
                        if (resultLines.length > 1) {
                            preview += ` ... +${resultLines.length - 1} lines`;
                        } else if (resultLines[0]?.length > 60) {
                            preview += "...";
                        }
                        console.log(`  ${DIM}⎿  ${preview}${RESET}`);

                        toolResults.push({
                            type: "tool_result",
                            tool_use_id: block.id,
                            content: resultStr,
                        });
                    }
                }

                messages.push({ role: "assistant", content: contentBlocks });

                if (toolResults.length === 0) {
                    break;
                }
                messages.push({ role: "user", content: toolResults });
            }
        } catch (err: any) {
            if (err.name === 'AbortError' || err.message === 'Interrupted') break;
            console.log(`${RED}⏺ Error: ${err.message}${RESET}`);
            console.error("DEBUG Stack:", err.stack);
        }
        console.log();
    }
}

if (import.meta.main) {
    main().catch(console.error);
}