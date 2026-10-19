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
    console.log(`From the wallet that owns ${config.botName}, point the name at that address.`);
} finally {
    await pkc.destroy();
}
