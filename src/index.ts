import fs from "node:fs";
import { loadAuthorProfile } from "./author.js";
import { startBot } from "./bot.js";
import { dbPath, loadConfig } from "./config.js";
import { BotDb } from "./db.js";
import { ImageLoader } from "./images.js";
import { AnthropicLlmClient } from "./llm/anthropic.js";
import { ClaudeCodeLlmClient } from "./llm/claude-code.js";
import { systemPrompt } from "./llm/content.js";
import { claudeCodeAccountSecrets } from "./llm/private-info.js";
import { createMentionRegex } from "./mentions.js";
import { assertNameResolvesToSigner, connectPkc, loadSigner } from "./pkc.js";

async function main() {
    const config = loadConfig();
    fs.mkdirSync(config.dataDir, { recursive: true });
    const db = new BotDb(dbPath(config.dataDir));
    const { pkc, url, close } = await connectPkc(config);
    console.log(`pkc RPC: ${url}`);
    const signer = await loadSigner(pkc, config.dataDir);
    await assertNameResolvesToSigner(pkc, config.botName, signer);

    const images = new ImageLoader(config.imageProxyUrl);
    const llm =
        config.llm.provider === "claude-code"
            ? new ClaudeCodeLlmClient(config.llm, images, systemPrompt(config), config.llm.claudeCodeBin)
            : new AnthropicLlmClient(config.llm, images, systemPrompt(config));

    // Claude Code puts the logged-in account's email and org id into every session; no reply may repeat them.
    // Without them the check would be blind, so the bot refuses to start.
    const privateStrings = [
        ...config.privateStrings,
        ...(config.llm.provider === "claude-code" ? await claudeCodeAccountSecrets(config.llm.claudeCodeBin) : [])
    ];
    if (config.llm.provider === "claude-code" && privateStrings.length === config.privateStrings.length)
        throw new Error("could not read the Claude Code account details to keep them out of replies (`claude auth status`)");

    console.log(`${config.botName} (${signer.address}) running, LLM: ${config.llm.provider} ${config.llm.model}, ${privateStrings.length} private string(s) guarded`);
    const bot = await startBot({
        pkc,
        signer,
        db,
        llm,
        privateStrings,
        config,
        authorProfile: loadAuthorProfile(config.dataDir),
        mentionRegex: createMentionRegex(config.botName)
    });

    const shutdown = async () => {
        console.log("shutting down");
        await bot.stop();
        await pkc.destroy();
        await close();
        db.close();
        process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
