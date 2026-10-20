// Operator command: registers a community directly, without a post in the registry community.
// It checks the community's public challenges like the registry does and refuses if any of them would
// still challenge the bot. The running bot picks the community up on its next start.
//
//   npm run register-community -- --community <address>
import fs from "node:fs";
import { parseArgs } from "node:util";
import { dbPath, loadConfig } from "../src/config.js";
import { BotDb } from "../src/db.js";
import { diagnoseInstall, type ChallengeWithExclude } from "../src/install/exclude.js";
import { connectPkc } from "../src/pkc.js";

const { values } = parseArgs({ options: { community: { type: "string" } } });

async function main() {
    if (!values.community) throw new Error("--community <address> is required");
    const config = loadConfig();
    const { pkc, close } = await connectPkc(config);
    try {
        const community = await pkc.getCommunity({ address: values.community });
        const { installed, problems } = diagnoseInstall(community.challenges as ChallengeWithExclude[], config.botName);
        if (!installed) throw new Error(`${values.community} does not exempt ${config.botName} yet:\n- ${problems.join("\n- ")}\nRun install-bot first.`);
        fs.mkdirSync(config.dataDir, { recursive: true });
        const db = new BotDb(dbPath(config.dataDir));
        db.installCommunity(community.address, "operator", null);
        db.close();
        console.log(`Registered ${community.address}. Restart the bot to start answering there.`);
    } finally {
        await pkc.destroy();
        await close();
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
