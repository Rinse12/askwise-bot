// Owner-side script: exempts the bot's name from every challenge of a community hosted on this
// machine's bitsocial-cli daemon. Safe to run again at any time; challenges that already exempt the
// bot are left alone, so re-running after adding new challenges only updates the new ones.
//
//   npm run install-bot -- --community <address> [--rpc <url>] [--uninstall] [--dry-run]
// The RPC is --rpc, else PKC_RPC_SSH_HOST (ssh tunnel) or PKC_RPC_URL from .env, else ws://localhost:9138.
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { runInstall, type InstallPkc } from "../src/install/run.js";
import { connectPkc } from "../src/pkc.js";

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
    if (!values.community) throw new Error("--community <address> is required");

    const { pkc, url, close } = await connectPkc(config, values.rpc);
    try {
        // pkc.communities (the communities this node hosts) arrives shortly after connecting
        if (pkc.communities.length === 0)
            await Promise.race([new Promise((resolve) => pkc.once("communitieschange", resolve)), new Promise((resolve) => setTimeout(resolve, 10_000))]);
        const report = await runInstall(pkc as unknown as InstallPkc, {
            address: values.community,
            botName: values["bot-name"] ?? config.botName,
            uninstall: values.uninstall,
            dryRun: values["dry-run"],
            rpcLabel: url,
            registryAddress: config.registryAddress
        });
        console.log(report.lines.join("\n"));
    } finally {
        await pkc.destroy();
        await close();
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
