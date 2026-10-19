// Stands in for a bitsocial-cli daemon: an offline Kubo node plus an in-process pkc RPC server whose
// name resolver is a mutable in-memory map, so the e2e test can point bitsocialbot.eth at any signer.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import PKCRpc from "@pkcprotocol/pkc-js/rpc";

export const nameRecords = new Map<string, string>();

const mockResolver = {
    key: "e2e-mock-resolver",
    provider: "mock",
    canResolve: () => true,
    resolve: async ({ name }: { name: string }) => {
        const publicKey = nameRecords.get(name.replace(/\.bso$/, ".eth"));
        return publicKey ? { publicKey } : undefined;
    }
};

const KUBO = process.env.KUBO_BIN || "ipfs";

const freePort = () =>
    new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as AddressInfo;
            server.close(() => resolve(port));
        });
    });

async function startKubo(dir: string, apiPort: number): Promise<ChildProcess> {
    const [gatewayPort, swarmPort] = [await freePort(), await freePort()];
    const env = { ...process.env, IPFS_PATH: dir };
    const ipfs = (...args: string[]) => execFileSync(KUBO, args, { env, stdio: "pipe" });
    ipfs("init", "--profile", "test");
    ipfs("bootstrap", "rm", "--all");
    ipfs("config", "--json", "Discovery.MDNS.Enabled", "false");
    ipfs("config", "Addresses.API", `/ip4/127.0.0.1/tcp/${apiPort}`);
    ipfs("config", "Addresses.Gateway", `/ip4/127.0.0.1/tcp/${gatewayPort}`);
    ipfs("config", "--json", "Addresses.Swarm", JSON.stringify([`/ip4/127.0.0.1/tcp/${swarmPort}`]));
    const daemon = spawn(KUBO, ["daemon", "--enable-namesys-pubsub", "--enable-pubsub-experiment"], { env, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("kubo did not start in 60s")), 60_000);
        daemon.stdout!.on("data", (chunk: Buffer) => {
            if (chunk.toString().includes("Daemon is ready")) {
                clearTimeout(timeout);
                resolve();
            }
        });
        let stderr = "";
        daemon.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        daemon.once("exit", (code) => reject(new Error(`kubo exited with code ${code}: ${stderr}`)));
    });
    return daemon;
}

export async function startRpcServer() {
    const port = await freePort();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bitsocialbot-e2e-"));
    const kuboApiPort = await freePort();
    const kubo = await startKubo(path.join(root, "kubo"), kuboApiPort);
    const kuboApi = `http://127.0.0.1:${kuboApiPort}/api/v0`;
    const server = await PKCRpc.PKCWsServer({
        port,
        pkcOptions: {
            dataPath: path.join(root, "pkc"),
            kuboRpcClientsOptions: [kuboApi],
            pubsubKuboRpcClientsOptions: [kuboApi],
            httpRoutersOptions: [],
            nameResolvers: [mockResolver],
            publishInterval: 1000,
            updateInterval: 500
        } as never
    });
    return {
        url: `ws://localhost:${port}`,
        root,
        stop: async () => {
            await server.destroy();
            kubo.kill("SIGTERM");
        }
    };
}
