import { describe, expect, it } from "vitest";
import { addBotExclude, botExcludeItem, challengesMissingBotExclude, diagnoseInstall, isBotExcludeItem, removeBotExclude } from "../src/install/exclude.js";

const BOT = "bitsocialbot.bso";

describe("isBotExcludeItem", () => {
    it("accepts the bot's own item and a plain names item", () => {
        expect(isBotExcludeItem(botExcludeItem(BOT), BOT)).toBe(true);
        expect(isBotExcludeItem({ names: ["someone.bso", BOT] }, BOT)).toBe(true);
    });
    it("rejects items that do not reliably exempt the bot's replies", () => {
        expect(isBotExcludeItem({ publicKeys: ["12D3KooWabc"] }, BOT)).toBe(false);
        expect(isBotExcludeItem({ names: ["other.bso"] }, BOT)).toBe(false);
        // pkc-js matches names as exact strings: another case or the .eth spelling does not exempt the bot
        expect(isBotExcludeItem({ names: ["BitsocialBot.bso"] }, BOT)).toBe(false);
        expect(isBotExcludeItem({ names: ["bitsocialbot.eth"] }, BOT)).toBe(false);
        expect(isBotExcludeItem({ names: [BOT], postScore: 10 }, BOT)).toBe(false);
        expect(isBotExcludeItem({ names: [BOT], publicationType: { vote: true } }, BOT)).toBe(false);
    });
});

describe("addBotExclude", () => {
    it("adds the item to every challenge and keeps existing excludes", () => {
        const challenges = [{ name: "question" }, { name: "captcha", exclude: [{ roles: ["moderator"] }] }];
        const { challenges: updated, changed, unchanged } = addBotExclude(challenges, BOT);
        expect(changed).toEqual([0, 1]);
        expect(unchanged).toEqual([]);
        expect(updated[0].exclude).toEqual([botExcludeItem(BOT)]);
        expect(updated[1].exclude).toEqual([{ roles: ["moderator"] }, botExcludeItem(BOT)]);
        expect(challenges[0]).toEqual({ name: "question" }); // input not mutated
    });

    it("is idempotent and only touches challenges added after a previous install", () => {
        const installed = addBotExclude([{ name: "question" }], BOT).challenges;
        const withNewChallenge = [...installed, { name: "text-math" }];
        const { challenges: updated, changed, unchanged } = addBotExclude(withNewChallenge, BOT);
        expect(changed).toEqual([1]);
        expect(unchanged).toEqual([0]);
        expect(updated[0]).toBe(installed[0]);
        expect(challengesMissingBotExclude(updated, BOT)).toEqual([]);
        expect(addBotExclude(updated, BOT).changed).toEqual([]);
    });

    it("treats no challenges as installed", () => {
        expect(addBotExclude([], BOT).changed).toEqual([]);
        expect(challengesMissingBotExclude([], BOT)).toEqual([]);
        expect(challengesMissingBotExclude(undefined, BOT)).toEqual([]);
    });

    it("does not count a publicKeys-only exclude as installed", () => {
        expect(challengesMissingBotExclude([{ exclude: [{ publicKeys: ["12D3KooWabc"] }] }], BOT)).toEqual([0]);
    });
});

describe("removeBotExclude", () => {
    it("removes the bot's item, keeps other excludes and drops empty exclude arrays", () => {
        const installed = addBotExclude([{ name: "question" }, { name: "captcha", exclude: [{ roles: ["moderator"] }] }], BOT).challenges;
        const { challenges: updated, changed } = removeBotExclude(installed, BOT);
        expect(changed).toEqual([0, 1]);
        expect(updated[0]).toEqual({ name: "question" });
        expect(updated[1]).toEqual({ name: "captcha", exclude: [{ roles: ["moderator"] }] });
    });

    it("keeps other names in a shared item", () => {
        const { challenges } = removeBotExclude([{ exclude: [{ names: ["friend.eth", BOT] }] }], BOT);
        expect(challenges[0].exclude).toEqual([{ names: ["friend.eth"] }]);
    });
});

describe("diagnoseInstall", () => {
    it("explains each challenge that does not exempt the bot", () => {
        const challenges = [
            { type: "text/plain", exclude: [botExcludeItem(BOT)] },
            { type: "text/plain" },
            { type: "url/iframe", exclude: [{ names: ["bitsocialbot.eth"] }] },
            { exclude: [{ names: ["BitsocialBot.bso"] }] },
            { exclude: [{ names: [BOT], postScore: 3 }] },
            { exclude: [{ names: [BOT], publicationType: { post: true } }] }
        ];
        const { installed, problems } = diagnoseInstall(challenges, BOT);
        expect(installed).toBe(false);
        expect(problems).toEqual([
            "challenge #1 (text/plain): it has no exclude for bitsocialbot.bso",
            'challenge #2 (url/iframe): its exclude names "bitsocialbot.eth", but it must be exactly "bitsocialbot.bso" (pkc-js compares names exactly)',
            'challenge #3: its exclude names "BitsocialBot.bso", but it must be exactly "bitsocialbot.bso" (pkc-js compares names exactly)',
            "challenge #4: its exclude for bitsocialbot.bso also requires postScore, so it does not always apply",
            "challenge #5: its exclude for bitsocialbot.bso does not cover replies (publicationType.reply)"
        ]);
    });

    it("reports installed when every challenge exempts the bot, or there are none", () => {
        expect(diagnoseInstall([{ exclude: [botExcludeItem(BOT)] }], BOT)).toEqual({ installed: true, problems: [] });
        expect(diagnoseInstall([], BOT).installed).toBe(true);
    });
});
