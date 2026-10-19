import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractImageUrls, ImageLoader } from "../src/images.js";
import { threadImages } from "../src/watcher.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

describe("extractImageUrls", () => {
    it("finds image links, markdown images and bare image urls", () => {
        expect(extractImageUrls({ link: "https://i.example/a", linkHtmlTagName: "img" })).toEqual(["https://i.example/a"]);
        expect(extractImageUrls({ link: "https://example.com/photo.JPG?x=1" })).toEqual(["https://example.com/photo.JPG?x=1"]);
        expect(extractImageUrls({ link: "https://example.com/article" })).toEqual([]);
        expect(
            extractImageUrls({ content: "look ![chart](https://c.example/chart) and https://x.example/a.webp, also https://x.example/page and ftp://x/y.png" })
        ).toEqual(["https://c.example/chart", "https://x.example/a.webp"]);
    });
});

describe("threadImages", () => {
    it("puts the calling comment's images first and labels where each came from", () => {
        const post = { cid: "p", depth: 0, timestamp: 1, link: "https://i.example/post.png" };
        const reply = { cid: "r", depth: 1, timestamp: 1, content: "https://i.example/reply.gif https://i.example/post.png" };
        const mention = { cid: "m", depth: 2, timestamp: 1, content: "@bitsocialbot what is ![x](https://i.example/m.jpg)" };
        expect(threadImages(mention, [post, reply])).toEqual([
            { url: "https://i.example/m.jpg", label: "in the comment calling you" },
            { url: "https://i.example/reply.gif", label: "in the reply at depth 1" },
            { url: "https://i.example/post.png", label: "in the reply at depth 1" }
        ]);
        expect(threadImages({ ...post, title: "@bitsocialbot ?" }, [])).toEqual([{ url: "https://i.example/post.png", label: "in the post calling you" }]);
    });
});

describe("ImageLoader", () => {
    let imageServer: http.Server;
    let proxy: http.Server;
    let proxied: string[] = [];
    let imagePort = 0;
    let proxyPort = 0;

    beforeAll(async () => {
        imageServer = http.createServer((req, res) => {
            if (req.url === "/a.png") res.writeHead(200, { "content-type": "image/png" }).end(PNG);
            else if (req.url === "/page") res.writeHead(200, { "content-type": "text/html" }).end("<html>");
            else res.writeHead(404).end();
        });
        await new Promise<void>((resolve) => imageServer.listen(0, "127.0.0.1", resolve));
        imagePort = (imageServer.address() as AddressInfo).port;

        // Minimal HTTP CONNECT/forward proxy that records what it carried
        proxy = http.createServer((req, res) => {
            proxied.push(req.url!);
            const target = new URL(req.url!);
            const upstream = http.request({ host: "127.0.0.1", port: imagePort, path: target.pathname, method: req.method, headers: req.headers }, (up) => {
                res.writeHead(up.statusCode!, up.headers);
                up.pipe(res);
            });
            req.pipe(upstream);
        });
        proxy.on("connect", (req, socket) => {
            proxied.push(req.url!);
            const upstream = net.connect(imagePort, "127.0.0.1", () => {
                socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                upstream.pipe(socket).pipe(upstream);
            });
        });
        await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
        proxyPort = (proxy.address() as AddressInfo).port;
    });

    afterAll(() => {
        imageServer.close();
        proxy.close();
    });

    it("passes the url through when no proxy is configured", async () => {
        const loader = new ImageLoader(undefined);
        expect(loader.viaProxy).toBe(false);
        expect(await loader.load("https://i.example/a.png")).toEqual({ type: "url", url: "https://i.example/a.png" });
    });

    it("downloads through the proxy and inlines the bytes", async () => {
        proxied = [];
        const loader = new ImageLoader(`http://127.0.0.1:${proxyPort}`);
        // The image host is a public-looking name that only the proxy can reach
        const image = await loader.load(`http://images.example.test/a.png`).catch((error) => error);
        // images.example.test does not resolve, but the proxy maps every host to the local image server
        expect(proxied.length).toBe(1);
        expect(image).toEqual({ type: "base64", media_type: "image/png", data: PNG.toString("base64") });
    });

    it("rejects non-image responses and private addresses", async () => {
        const loader = new ImageLoader(`http://127.0.0.1:${proxyPort}`);
        await expect(loader.load("http://images.example.test/page")).rejects.toThrow(/unsupported content type/);
        await expect(loader.load(`http://127.0.0.1:${imagePort}/a.png`)).rejects.toThrow(/private network/);
        await expect(loader.load("http://192.168.1.10/a.png")).rejects.toThrow(/private network/);
    });

    it("rejects unknown proxy schemes", () => {
        expect(() => new ImageLoader("ftp://proxy")).toThrow(/IMAGE_PROXY_URL/);
    });
});
