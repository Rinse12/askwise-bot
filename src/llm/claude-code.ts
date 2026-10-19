import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../config.js";
import type { ImageLoader } from "../images.js";
import { buildContent, contentWithoutFailedImages, SYSTEM_PROMPT, type ContentBlock } from "./content.js";
import { LlmRefusalError, type LlmClient, type LlmReply, type LlmRequest } from "./types.js";

const TIMEOUT_MS = 5 * 60_000;

interface ClaudeCodeResult {
    type: "result";
    is_error: boolean;
    result?: string;
    stop_reason?: string;
    total_cost_usd?: number;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    modelUsage?: Record<string, unknown>;
}

// Runs the local `claude` CLI headless, so replies use the Claude subscription it is logged in with
// instead of an API key. Each call is a fresh, tool-less session: no tools (so thread content cannot make
// it run anything), our system prompt instead of Claude Code's, no settings, CLAUDE.md, MCP servers or
// skills, and an empty working directory. Images go as content blocks: a URL is fetched by Anthropic,
// never by this machine, exactly as with the API.
//
// The working directory is a fresh temp directory outside any git repo or project on purpose: Claude Code
// injects context based on it (git status, the project's auto-memory notes), which would leak the
// operator's private notes into replies that strangers can prompt.
export class ClaudeCodeLlmClient implements LlmClient {
    private cwd: string;

    constructor(
        private llmConfig: Config["llm"],
        private images: ImageLoader,
        private bin = "claude"
    ) {
        this.cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bitsocialbot-claude-"));
    }

    private run(content: ContentBlock[]): Promise<ClaudeCodeResult> {
        const args = [
            "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--tools", "",
            "--system-prompt", SYSTEM_PROMPT,
            "--model", this.llmConfig.model,
            "--effort", this.llmConfig.effort,
            "--setting-sources", "",
            "--strict-mcp-config",
            "--disable-slash-commands",
            "--no-session-persistence"
        ];
        // An API key in the environment would make the CLI bill the API instead of the subscription.
        // The documented switches below keep auto-memory, CLAUDE.md files and git instructions out of the
        // session. The account's email, environment info and the date are still injected; no setting
        // removes them while keeping subscription login.
        const { ANTHROPIC_API_KEY: _apiKey, ...inherited } = process.env;
        const env = {
            ...inherited,
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
            CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
            CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
            CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1"
        };

        return new Promise((resolve, reject) => {
            const child = spawn(this.bin, args, { cwd: this.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
            let stdout = "";
            let stderr = "";
            const timeout = setTimeout(() => {
                child.kill("SIGTERM");
                reject(new Error(`claude CLI timed out after ${TIMEOUT_MS / 1000}s`));
            }, TIMEOUT_MS);
            child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
            child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
            child.on("error", (error) => {
                clearTimeout(timeout);
                reject(new Error(`could not run the claude CLI (${this.bin}): ${error.message}`));
            });
            child.on("close", (code) => {
                clearTimeout(timeout);
                const result = stdout
                    .split("\n")
                    .filter((line) => line.startsWith("{"))
                    .map((line) => JSON.parse(line) as { type?: string })
                    .find((event): event is ClaudeCodeResult => event.type === "result");
                if (result) resolve(result);
                else reject(new Error(`claude CLI exited with code ${code} without a result: ${stderr.trim() || stdout.trim().slice(-500)}`));
            });
            child.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
        });
    }

    async reply(request: LlmRequest): Promise<LlmReply> {
        const content = await buildContent(request, this.images, this.llmConfig.maxImages);
        let result = await this.run(content);
        // A 400 with images in the request is most likely an image URL Anthropic could not fetch
        for (const attempt of contentWithoutFailedImages(content)) {
            if (!result.is_error || !/API Error: 400/.test(result.result ?? "")) break;
            console.warn(`an image could not be loaded, retrying without it: ${result.result}`);
            result = await this.run(attempt);
        }
        if (result.is_error) throw new Error(`claude CLI error: ${result.result ?? "unknown"}`);

        const reply: LlmReply = {
            text: (result.result ?? "").trim(),
            model: Object.keys(result.modelUsage ?? {})[0] ?? this.llmConfig.model,
            inputTokens: result.usage?.input_tokens ?? 0,
            outputTokens: result.usage?.output_tokens ?? 0,
            cacheReadTokens: result.usage?.cache_read_input_tokens ?? 0,
            cacheWriteTokens: result.usage?.cache_creation_input_tokens ?? 0,
            // What the call would cost at API prices; on a subscription it counts against the plan's limits
            // instead, but it keeps the spend caps and the usage report meaningful.
            costUsd: result.total_cost_usd ?? 0
        };
        if (result.stop_reason === "refusal") throw Object.assign(new LlmRefusalError("LLM refused"), { reply });
        return reply;
    }
}
