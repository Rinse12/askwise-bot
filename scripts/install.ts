// Owner-side script: exempts the bot's name from every challenge of a community hosted on this
// machine's bitsocial-cli daemon. Safe to run again at any time; challenges that already exempt the
// bot are left alone, so re-running after adding new challenges only updates the new ones.
//
//   npm run install-bot -- --community <address> [--rpc ws://localhost:9138] [--uninstall] [--dry-run]
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { addBotExclude, challengesMissingBotExclude, removeBotExclude, type ChallengeWithExclude } from "../src/install/exclude.js";
import { createPkc } from "../src/pkc.js";

const { values } = parseArgs({
    options: {
        community: { type: "string" },
        rpc: { type: "string" },
        "bot-name": { type: "string" },
        uninstall: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false }
    }
});

async function main() {
    const config = loadConfig();
    const botName = (values["bot-name"] ?? config.botName).toLowerCase();
    const rpcUrl = values.rpc ?? "ws://localhost:9138";
    if (!values.community) throw new Error("--community <address> is required");

    const pkc = await createPkc(rpcUrl);
    try {
        // pkc.communities lists the communities this node hosts; only those have editable settings
        if (pkc.communities.length === 0)
            await Promise.race([new Promise((resolve) => pkc.once("communitieschange", resolve)), new Promise((resolve) => setTimeout(resolve, 10_000))]);
        const hosted = pkc.communities;
        if (!hosted.includes(values.community))
            throw new Error(`${values.community} is not hosted by the node at ${rpcUrl}. Hosted communities: ${hosted.join(", ") || "none"}`);

        const community = await pkc.createCommunity({ address: values.community });
        const settings = community.settings;
        if (!settings) throw new Error(`could not read the settings of ${values.community}; is ${rpcUrl} the node that runs it?`);
        const current = (settings.challenges ?? []) as ChallengeWithExclude[];

        if (current.length === 0 && !values.uninstall)
            console.log(`${values.community} has no challenges, so ${botName} can already publish. Nothing to change.`);

        const change = values.uninstall ? removeBotExclude(current, botName) : addBotExclude(current, botName);
        const describe = (challenge: ChallengeWithExclude) => String(challenge.name ?? challenge.path ?? "unnamed");
        for (const index of change.changed)
            console.log(`  challenge #${index} (${describe(current[index])}): ${values.uninstall ? "removed" : "added"} exclude for ${botName}`);
        for (const index of change.unchanged)
            console.log(`  challenge #${index} (${describe(current[index])}): ${values.uninstall ? "had no exclude for the bot" : "already excludes the bot"}`);

        if (change.changed.length === 0) {
            console.log("No changes needed.");
        } else if (values["dry-run"]) {
            console.log("\n--dry-run: new settings.challenges would be:");
            console.log(JSON.stringify(change.challenges, null, 2));
        } else {
            await community.edit({ settings: { ...settings, challenges: change.challenges as typeof settings.challenges } });
            console.log(`\nSaved settings of ${values.community}.`);
        }

        if (!values.uninstall && !values["dry-run"] && challengesMissingBotExclude(change.challenges, botName).length === 0) {
            console.log(
                `\nNext step: once the community has published this update, make a post in the registry community${config.registryAddress ? ` (${config.registryAddress})` : ""} ` +
                    `from the owner or an admin account, containing just: ${values.community}`
            );
        }
        if (values.uninstall && !values["dry-run"]) console.log(`${botName} will stop answering in ${values.community} on its next update.`);
    } finally {
        await pkc.destroy();
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
