import fs from "node:fs/promises";
import path from "node:path";
import PKC from "@pkcprotocol/pkc-js";
import type { Config } from "./config.js";
import { openSshTunnel } from "./ssh-tunnel.js";

export type PkcInstance = Awaited<ReturnType<typeof PKC>>;
export type BotSigner = Awaited<ReturnType<PkcInstance["createSigner"]>>;
export type RemoteCommunity = Awaited<ReturnType<PkcInstance["getCommunity"]>>;

export async function createPkc(rpcUrl: string): Promise<PkcInstance> {
    const pkc = await PKC({ pkcRpcClientsOptions: [rpcUrl] });
    // pkc-js has no default error listener; without one an unhandled 'error' would crash the process
    pkc.on("error", (error: unknown) => console.error("pkc error:", error));
    return pkc;
}

// Connects to the configured pkc RPC: directly, or through an ssh tunnel when PKC_RPC_SSH_HOST is set.
// An explicit rpcUrl (e.g. install-bot --rpc) always connects directly.
export async function connectPkc(config: Pick<Config, "pkcRpcUrl" | "pkcRpcSshHost" | "pkcRpcSshRemote">, rpcUrl?: string) {
    if (rpcUrl || !config.pkcRpcSshHost) {
        const url = rpcUrl ?? config.pkcRpcUrl;
        return { pkc: await createPkc(url), url, close: async () => {} };
    }
    const tunnel = await openSshTunnel(config.pkcRpcSshHost, config.pkcRpcSshRemote);
    try {
        const pkc = await createPkc(tunnel.localUrl);
        return { pkc, url: `ssh ${config.pkcRpcSshHost} -> ${config.pkcRpcSshRemote}`, close: async () => tunnel.close() };
    } catch (error) {
        tunnel.close();
        throw error;
    }
}

export const signerPath = (dataDir: string) => path.join(dataDir, "bot-signer.json");

interface StoredSigner {
    type: "ed25519";
    privateKey: string;
}

export async function loadSigner(pkc: PkcInstance, dataDir: string): Promise<BotSigner> {
    let stored: StoredSigner;
    try {
        stored = JSON.parse(await fs.readFile(signerPath(dataDir), "utf8"));
    } catch (error) {
        throw new Error(`Could not read ${signerPath(dataDir)}. Run \`npm run create-signer\` first.`, { cause: error });
    }
    return pkc.createSigner({ type: stored.type, privateKey: stored.privateKey });
}

export async function createAndStoreSigner(pkc: PkcInstance, dataDir: string): Promise<BotSigner> {
    const file = signerPath(dataDir);
    const exists = await fs.stat(file).then(
        () => true,
        () => false
    );
    if (exists) throw new Error(`${file} already exists; move it away first if you really want to rotate the key`);
    const signer = await pkc.createSigner();
    await fs.mkdir(dataDir, { recursive: true });
    const stored: StoredSigner = { type: "ed25519", privateKey: signer.privateKey! };
    await fs.writeFile(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
    return signer;
}

// The challenge exclude matches on the name only when the name resolves to the signing key,
// so a bot whose name points elsewhere would get challenged on every publish.
export async function assertNameResolvesToSigner(pkc: PkcInstance, botName: string, signer: BotSigner) {
    const { resolvedAuthorName } = await pkc.resolveAuthorName({ name: botName, cache: { maxAge: 0 } });
    if (resolvedAuthorName !== signer.address)
        throw new Error(
            `${botName} resolves to ${resolvedAuthorName ?? "nothing"}, but the bot signer is ${signer.address}. ` +
                `Point the name's record at ${signer.address} (from the wallet that owns the name) before starting the bot.`
        );
}
