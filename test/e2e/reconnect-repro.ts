// Repro: does a pkc RPC client's community.update() subscription keep delivering updates after the
// websocket connection drops and auto-reconnects?
//
//   npx tsx test/e2e/reconnect-repro.ts
import net from "node:net";
import type { AddressInfo } from "node:net";
import { createPkc } from "../../src/pkc.js";
import { startRpcServer } from "./server.js";

const { url, stop } = await startRpcServer();
const serverPort = Number(new URL(url).port);

// TCP relay between the client and the RPC server, so the connection can be cut like a network drop
const sockets = new Set<net.Socket>();
const relay = net.createServer((client) => {
    const upstream = net.connect(serverPort, "127.0.0.1");
    client.pipe(upstream).pipe(client);
    for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {});
    }
});
await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
const relayUrl = `ws://127.0.0.1:${(relay.address() as AddressInfo).port}`;

const owner = await createPkc(url); // direct connection, used to change the community
const community = await owner.createCommunity({ title: "title 0" });
await community.start();
await new Promise((resolve) => community.once("update", resolve));

const watcher = await createPkc(relayUrl); // the connection that gets cut
const rpcClient = Object.values(watcher.clients.pkcRpcClients)[0];
rpcClient.on("statechange", (state: string) => console.log(`  watcher rpc state: ${state}`));
const remote = await watcher.getCommunity({ address: community.address });
const titles: string[] = [];
remote.on("update", () => {
    if (titles.at(-1) !== remote.title) titles.push(remote.title!);
});
await remote.update();

const waitForTitle = async (title: string, ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (remote.title === title) return true;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
};

await community.edit({ title: "title 1" });
console.log("before the drop, update received:", await waitForTitle("title 1", 30_000));

console.log("cutting the connection");
for (const socket of sockets) socket.destroy();
await new Promise((resolve) => setTimeout(resolve, 8000)); // give the client time to auto-reconnect
console.log("watcher rpc state after waiting:", rpcClient.state);

await community.edit({ title: "title 2" });
const received = await waitForTitle("title 2", 60_000);
console.log("after the reconnect, update received:", received);
console.log("titles seen by the watcher:", titles);
console.log(received ? "RESULT: subscription survived the reconnect" : "RESULT: subscription went silent after the reconnect");

await remote.stop().catch(() => {});
await Promise.allSettled([watcher.destroy(), owner.destroy()]);
relay.close();
await stop();
process.exit(0);
