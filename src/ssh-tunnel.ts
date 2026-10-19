import { spawn, type ChildProcess } from "node:child_process";
import net, { type AddressInfo } from "node:net";

export interface SshTunnel {
    localUrl: string;
    close(): void;
}

const freePort = () =>
    new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as AddressInfo;
            server.close(() => resolve(port));
        });
    });

const canConnect = (port: number) =>
    new Promise<boolean>((resolve) => {
        const socket = net.connect(port, "127.0.0.1");
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => resolve(false));
    });

// Forwards a local port to the pkc RPC on another machine over ssh (`ssh -N -L`), so that machine's
// bitsocial-cli daemon can serve as the bot's node. The host is anything ssh accepts, including a Host
// alias from ~/.ssh/config. The daemon sees the connection as local, so no RPC auth key is needed.
// If ssh exits, it is restarted; the pkc RPC client reconnects on its own.
export async function openSshTunnel(host: string, remote = "127.0.0.1:9138"): Promise<SshTunnel> {
    const localPort = await freePort();
    let child: ChildProcess | undefined;
    let closed = false;
    let lastError = "";

    const start = () => {
        child = spawn(
            "ssh",
            ["-N", "-L", `127.0.0.1:${localPort}:${remote}`, "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", host],
            { stdio: ["ignore", "ignore", "pipe"] }
        );
        child.stderr!.on("data", (chunk: Buffer) => {
            const text = chunk.toString().trim();
            // OpenSSH's post-quantum key exchange notice is not an error
            if (text && !/post-quantum|store now, decrypt later|openssh\.com\/pq/.test(text)) lastError = text;
        });
        child.once("exit", (code) => {
            if (closed) return;
            console.warn(`ssh tunnel to ${host} exited (code ${code})${lastError ? `: ${lastError}` : ""}; restarting in 5s`);
            setTimeout(() => !closed && start(), 5000);
        });
    };
    start();

    const deadline = Date.now() + 20_000;
    while (!(await canConnect(localPort))) {
        if (Date.now() > deadline) {
            closed = true;
            child?.kill();
            throw new Error(`ssh tunnel to ${host} (${remote}) did not come up${lastError ? `: ${lastError}` : ""}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return {
        localUrl: `ws://127.0.0.1:${localPort}`,
        close: () => {
            closed = true;
            child?.kill();
        }
    };
}
