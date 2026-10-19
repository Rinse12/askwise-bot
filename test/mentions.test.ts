import { describe, expect, it } from "vitest";
import { buildThreadContext, createMentionRegex, mentionsBot } from "../src/mentions.js";
import { parseRegisteredAddress } from "../src/registry.js";

const regex = createMentionRegex("bitsocialbot.bso");
const matches = (text: string) => regex.test(text);

describe("createMentionRegex", () => {
    it.each(["@bitsocialbot is this true?", "hey @BitsocialBot.", "@bitsocialbot.bso explain", "ask u/bitsocialbot.bso", "bitsocialbot.bso, thoughts?", "(@bitsocialbot)", "@bitsocialbot.bso"])(
        "matches %s",
        (text) => expect(matches(text)).toBe(true)
    );
    it.each(["bitsocialbot is cool", "@bitsocialbotfan", "email me@bitsocialbot.bso", "https://x.com/bitsocialbot.bso", "bitsocialbot.bso.com", "@bitsocialbot_2"])(
        "does not match %s",
        (text) => expect(matches(text)).toBe(false)
    );
});

describe("mentionsBot", () => {
    it("checks a post's title and content", () => {
        expect(mentionsBot({ cid: "a", title: "@bitsocialbot explain X", content: "details" }, regex)).toBe(true);
        expect(mentionsBot({ cid: "a", title: "a question", content: "@bitsocialbot ?" }, regex)).toBe(true);
    });
    it("checks a nested reply's content", () => {
        expect(mentionsBot({ cid: "r", depth: 3, content: "@bitsocialbot is this true" }, regex)).toBe(true);
        expect(mentionsBot({ cid: "r", depth: 3, content: "no mention" }, regex)).toBe(false);
    });
});

describe("buildThreadContext", () => {
    it("renders the thread from the post down to the calling comment", () => {
        const context = buildThreadContext({ cid: "m", depth: 2, content: "@bitsocialbot is this true?", author: { address: "carol.eth" } }, [
            { cid: "p", depth: 0, title: "Claim", content: "The moon is cheese", author: { address: "alice.eth", displayName: "Alice" } },
            { cid: "r", depth: 1, content: "source?", author: { address: "bob.eth" } }
        ]);
        expect(context).toContain("[post] Alice (alice.eth):\nTitle: Claim\nThe moon is cheese");
        expect(context).toContain("[reply depth 1] bob.eth:\nsource?");
        expect(context.endsWith("[comment calling you] carol.eth:\n@bitsocialbot is this true?")).toBe(true);
    });
});

describe("parseRegisteredAddress", () => {
    it("finds a domain or a public key", () => {
        expect(parseRegisteredAddress({ title: "Register", content: "memes.bso" })).toBe("memes.bso");
        expect(parseRegisteredAddress({ title: "please add news.eth thanks" })).toBe("news.eth");
        const key = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";
        expect(parseRegisteredAddress({ content: `my community ${key}` })).toBe(key);
        expect(parseRegisteredAddress({ title: "hello" })).toBeUndefined();
    });
});
