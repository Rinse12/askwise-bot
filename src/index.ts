import fs from "node:fs";
import path from "node:path";
import { loadAuthorProfile } from "./author.js";
import { startBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { BotDb } from "./db.js";
import { ImageLoader } from "./images.js";
import { AnthropicLlmClient } from "./llm/anthropic.js";
import { ClaudeCodeLlmClient } from "./llm/claude-code.js";
import { createMentionRegex } from "./mentions.js";
import { assertNameResolvesToSigner, connectPkc, loadSigner } from "./pkc.js";

async function main() {
    const config = loadConfig();
    fs.mkdirSync(config.dataDir, { recursive: true });
    const db = new BotDb(path.join(config.dataDir, "bitsocialbot.db"));
    const { pkc, url, close } = await connectPkc(config);
    console.log(`pkc RPC: ${url}`);
    const signer = await loadSigner(pkc, config.dataDir);
    await assertNameResolvesToSigner(pkc, config.botName, signer);

    const images = new ImageLoader(config.imageProxyUrl);
    const llm =
        config.llm.provider === "claude-code"
            ? new ClaudeCodeLlmClient(config.llm, images, config.llm.claudeCodeBin)
            : new AnthropicLlmClient(config.llm, images);

    console.log(`${config.botName} (${signer.address}) running, LLM: ${config.llm.provider} ${config.llm.model}`);
    const bot = await startBot({
        pkc,
        signer,
        db,
        llm,
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
