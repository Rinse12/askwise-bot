// Owner-side script: for each challenge of a community hosted on this machine's bitsocial-cli daemon, asks
// whether to exempt the bot's name or keep checking its replies. Safe to run again at any time; only
// challenges not decided yet are asked about, so re-running after adding new challenges only asks about those.
//
//   npm run install-bot -- --community <address> [--rpc <url>] [--ask-all | --exempt-all] [--uninstall] [--dry-run]
// The RPC is --rpc, else PKC_RPC_SSH_HOST (ssh tunnel) or PKC_RPC_URL from .env, else ws://localhost:9138.
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { describeChallenge, runInstall, type DecideChallenge, type InstallPkc } from "../src/install/run.js";
import { connectPkc } from "../src/pkc.js";

const { values } = parseArgs({
    options: {
        community: { type: "string" },
        rpc: { type: "string" },
        "bot-name": { type: "string" },
        "ask-all": { type: "boolean", default: false },
        "exempt-all": { type: "boolean", default: false },
        uninstall: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false }
    }
});

// No default answer: whether a challenge should also check the bot is the owner's call. Options are not shown,
// since they can hold API keys.
function askOwner(botName: string): { decide: DecideChallenge; close: () => void } {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
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
        for (;;) {
            const answer = (await rl.question(`challenge #${index} (${describeChallenge(challenge)})${description}\n  exempt ${botName}? [y/n] `)).trim().toLowerCase();
            if (answer === "y" || answer === "yes") return true;
            if (answer === "n" || answer === "no") return false;
        }
    };
    return { decide, close: () => rl.close() };
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
