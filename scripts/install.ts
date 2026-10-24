// Owner-side script: for each challenge of a community hosted on this machine's bitsocial-cli daemon, asks
// whether to exempt the bot's name or keep checking its replies. Safe to run again at any time; only
// challenges not decided yet are asked about, so re-running after adding new challenges only asks about those.
// It then offers to add a "🤖 bot" author flair, unless the community already has one.
//
//   npm run install-bot -- --community <address> [--rpc <url>] [--ask-all | --exempt-all] [--bot-flair | --no-bot-flair] [--uninstall] [--dry-run]
// The RPC is --rpc, else PKC_RPC_SSH_HOST (ssh tunnel) or PKC_RPC_URL from .env, else ws://localhost:9138.
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { BOT_FLAIR, describeChallenge, runInstall, type DecideBotFlair, type DecideChallenge, type InstallPkc } from "../src/install/run.js";
import { connectPkc } from "../src/pkc.js";

const { values } = parseArgs({
    // --no-bot-flair answers the flair question with no
    allowNegative: true,
    options: {
        community: { type: "string" },
        rpc: { type: "string" },
        "bot-name": { type: "string" },
        "ask-all": { type: "boolean", default: false },
        "exempt-all": { type: "boolean", default: false },
        "bot-flair": { type: "boolean" },
        uninstall: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false }
    }
});

// No default answer: whether a challenge should also check the bot is the owner's call. Options are not shown,
// since they can hold API keys.
function askOwner(botName: string): { decide: DecideChallenge; decideBotFlair: DecideBotFlair; close: () => void } {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const yesNo = async (question: string) => {
        for (;;) {
            const answer = (await rl.question(question)).trim().toLowerCase();
            if (answer === "y" || answer === "yes") return true;
            if (answer === "n" || answer === "no") return false;
        }
    };
    let explained = false;
    const decide: DecideChallenge = async (challenge, index) => {
        if (!explained) {
            explained = true;
            console.log(
                `For each challenge, choose whether ${botName} is exempt from it.\n` +
                    "  y: the bot's replies skip it.\n" +
                    "  n: the bot's replies must pass it, e.g. to keep AI moderation on the bot. If it asks a question\n" +
                    "     (a captcha, a quiz...), the bot cannot answer and will not reply in this community.\n"
            );
        }
        const description = typeof challenge.description === "string" ? ` - ${challenge.description}` : "";
        return yesNo(`challenge #${index} (${describeChallenge(challenge)})${description}\n  exempt ${botName}? [y/n] `);
    };
    // Explains what the flair is for and what turning it on changes for everyone else, since that part is not obvious
    const decideBotFlair: DecideBotFlair = async ({ enablesAuthorFlairs, existingAuthorFlairs }) => {
        const listed = existingAuthorFlairs.length > 0 ? `the ones you already list (${existingAuthorFlairs.map((text) => `"${text}"`).join(", ")}) and ` : "";
        console.log(
            `\nBot badge (optional)\n` +
                `  Why: ${botName}'s replies are written by an AI. A "${BOT_FLAIR.text}" flair next to its name lets readers see\n` +
                "  that at a glance, instead of having to recognise the name.\n" +
                "  Why the community must add it: a community only accepts author flairs from its own list\n" +
                "  (flairs.author), and only when features.authorFlairs is on. The bot cannot badge itself.\n" +
                `  What changes: "${BOT_FLAIR.text}" is added to flairs.author` +
                (enablesAuthorFlairs
                    ? ", and features.authorFlairs is turned on.\n" +
                      `  That setting is community-wide: every author can then pick their own flair from flairs.author, i.e.\n` +
                      `  ${listed}"${BOT_FLAIR.text}".\n`
                    : ".\n") +
                `  So anyone can wear the badge: it is a label, not proof. Only the name ${botName} proves a reply is the bot's.\n` +
                "  Without it, the bot works the same, its replies just carry no badge.\n"
        );
        return yesNo(`  add the "${BOT_FLAIR.text}" author flair? [y/n] `);
    };
    return { decide, decideBotFlair, close: () => rl.close() };
}

async function main() {
    const config = loadConfig();
    if (!values.community) throw new Error("--community <address> is required");
    if (values["ask-all"] && values["exempt-all"]) throw new Error("--ask-all and --exempt-all cannot be combined");
    const botName = values["bot-name"] ?? config.botName;
    const asking = !values.uninstall && !values["exempt-all"];
    if (asking && !process.stdin.isTTY) throw new Error("the install script asks about each challenge; run it in a terminal, or pass --exempt-all");
    const owner = asking ? askOwner(botName) : undefined;

    const { pkc, url, close } = await connectPkc(config, values.rpc);
    try {
        // pkc.communities (the communities this node hosts) arrives shortly after connecting
        if (pkc.communities.length === 0)
            await Promise.race([new Promise((resolve) => pkc.once("communitieschange", resolve)), new Promise((resolve) => setTimeout(resolve, 10_000))]);
        const report = await runInstall(pkc as unknown as InstallPkc, {
            address: values.community,
            botName,
            decide: owner?.decide,
            decideBotFlair: owner?.decideBotFlair,
            botFlair: values["bot-flair"],
            exemptAll: values["exempt-all"],
            askAll: values["ask-all"],
            uninstall: values.uninstall,
            dryRun: values["dry-run"],
            rpcLabel: url,
            registryAddress: config.registryAddress
        });
        console.log(report.lines.join("\n"));
    } finally {
        owner?.close();
        await pkc.destroy();
        await close();
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
