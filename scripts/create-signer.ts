// Creates the bot's signing key in data/bot-signer.json and prints the address the bot's name must point to.
// Key generation is local, so this needs no running node.
import PKC from "@pkcprotocol/pkc-js";
import { loadConfig } from "../src/config.js";
import { createAndStoreSigner } from "../src/pkc.js";

const config = loadConfig();
const pkc = await PKC({ dataPath: undefined, httpRoutersOptions: [] });
try {
    const signer = await createAndStoreSigner(pkc, config.dataDir);
    console.log(`Signer saved. Its address is:\n\n  ${signer.address}\n`);
    const ensName = config.botName.replace(/\.bso$/, ".eth");
    console.log(`From the wallet that owns ${ensName} on ENS, set its text record "bitsocial" to that address.`);
    console.log(`That makes ${config.botName} resolve to the bot's key.`);
} finally {
    await pkc.destroy();
}
