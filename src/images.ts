import net from "node:net";
import { fetch, ProxyAgent, type Dispatcher } from "undici";
import { socksDispatcher } from "fetch-socks";

export interface ThreadImage {
    url: string;
    label: string;
}

export type LoadedImage =
    | { type: "url"; url: string }
    | { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string };

const IMAGE_EXTENSION = /\.(?:jpe?g|png|gif|webp)$/i;
const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

const isHttpUrl = (text: string) => {
    try {
        const url = new URL(text);
        return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
    } catch {
        return undefined;
    }
};

// Image links of a post (link with linkHtmlTagName "img", or an image file extension) plus images
// embedded in markdown or pasted as bare image URLs in the title/content.
export function extractImageUrls(comment: { link?: unknown; linkHtmlTagName?: unknown; title?: string; content?: string }): string[] {
    const urls: string[] = [];
    if (typeof comment.link === "string") {
        const url = isHttpUrl(comment.link);
        if (url && (comment.linkHtmlTagName === "img" || IMAGE_EXTENSION.test(url.pathname))) urls.push(comment.link);
    }
    const text = `${comment.title ?? ""}\n${comment.content ?? ""}`;
    for (const match of text.matchAll(/!\[[^\]]*\]\((\S+?)\)/g)) if (isHttpUrl(match[1])) urls.push(match[1]);
    for (const match of text.matchAll(/https?:\/\/[^\s)<>"']+/g)) {
        // sentence punctuation right after a pasted link is not part of it
        const candidate = match[0].replace(/[.,;:!?]+$/, "");
        const url = isHttpUrl(candidate);
        if (url && IMAGE_EXTENSION.test(url.pathname)) urls.push(candidate);
    }
    return [...new Set(urls)];
}

const isPrivateHost = (hostname: string) => {
    const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".lan")) return true;
    if (net.isIPv4(host)) return /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host);
    if (net.isIPv6(host)) return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80");
    return false;
};

function createDispatcher(proxyUrl: string): Dispatcher {
    const proxy = new URL(proxyUrl);
    if (proxy.protocol === "socks5:" || proxy.protocol === "socks5h:" || proxy.protocol === "socks4:")
        return socksDispatcher({
            type: proxy.protocol === "socks4:" ? 4 : 5,
            host: proxy.hostname.replace(/^\[|\]$/g, ""),
            port: Number(proxy.port || 1080),
            ...(proxy.username ? { userId: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) } : {})
        });
    if (proxy.protocol === "http:" || proxy.protocol === "https:") return new ProxyAgent(proxyUrl);
    throw new Error(`IMAGE_PROXY_URL must be http(s)://, socks5:// or socks4://, got ${proxy.protocol}`);
}

// Gets images to the LLM without exposing the bot's IP address to whoever hosts them:
// - with a proxy configured, the bot downloads the image through it and sends the bytes inline;
// - without one, the image is passed by URL and Anthropic's servers fetch it, never the bot.
export class ImageLoader {
    private dispatcher?: Dispatcher;

    constructor(proxyUrl: string | undefined) {
        if (proxyUrl) this.dispatcher = createDispatcher(proxyUrl);
    }

    get viaProxy() {
        return this.dispatcher !== undefined;
    }

    async load(url: string): Promise<LoadedImage> {
        if (!this.dispatcher) return { type: "url", url };

        const parsed = isHttpUrl(url);
        if (!parsed) throw new Error("not an http(s) url");
        if (isPrivateHost(parsed.hostname)) throw new Error("refusing to fetch a private network address");

        const response = await fetch(url, { dispatcher: this.dispatcher, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        const mediaType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
        if (!MEDIA_TYPES.has(mediaType)) throw new Error(`unsupported content type "${mediaType}"`);
        const declared = Number(response.headers.get("content-length") ?? 0);
        if (declared > MAX_IMAGE_BYTES) throw new Error(`image larger than ${MAX_IMAGE_BYTES} bytes`);

        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > MAX_IMAGE_BYTES) throw new Error(`image larger than ${MAX_IMAGE_BYTES} bytes`);
            chunks.push(Buffer.from(chunk));
        }
        return { type: "base64", media_type: mediaType as Extract<LoadedImage, { type: "base64" }>["media_type"], data: Buffer.concat(chunks).toString("base64") };
    }
}
