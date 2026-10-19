import fs from "node:fs";
import path from "node:path";
import { loadAuthorProfile } from "./author.js";
import { startBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { BotDb } from "./db.js";
import { ImageLoader } from "./images.js";
import { AnthropicLlmClient } from "./llm/anthropic.js";
import { createMentionRegex } from "./mentions.js";
import { assertNameResolvesToSigner, createPkc, loadSigner } from "./pkc.js";

async function main() {
    const config = loadConfig();
    fs.mkdirSync(config.dataDir, { recursive: true });
    const db = new BotDb(path.join(config.dataDir, "bitsocialbot.db"));
    const pkc = await createPkc(config.pkcRpcUrl);
    const signer = await loadSigner(pkc, config.dataDir);
    await assertNameResolvesToSigner(pkc, config.botName, signer);

    console.log(`${config.botName} (${signer.address}) running`);
    const bot = await startBot({
        pkc,
        signer,
        db,
        llm: new AnthropicLlmClient(config.llm, new ImageLoader(config.imageProxyUrl)),
        config,
        authorProfile: loadAuthorProfile(config.dataDir),
        mentionRegex: createMentionRegex(config.botName)
    });

    const shutdown = async () => {
        console.log("shutting down");
        await bot.stop();
        await pkc.destroy();
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
