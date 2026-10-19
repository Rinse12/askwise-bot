import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBotAuthor, pickBotFlair, PREVIOUS_COMMENT_CID_KEY } from "../src/author.js";
import { BotDb } from "../src/db.js";

const botFlair = { text: "Bot", backgroundColor: "#000" };
const config = { botName: "bitsocialbot.bso", botDisplayName: "Bitsocial Bot" };

describe("pickBotFlair", () => {
    it("uses the community's own bot author flair when author flairs are enabled", () => {
        expect(pickBotFlair({ features: { authorFlairs: true }, flairs: { author: [{ text: "human" }, botFlair] } })).toBe(botFlair);
    });
    it("sends no flair when the community does not allow or offer one", () => {
        expect(pickBotFlair({ features: {}, flairs: { author: [botFlair] } })).toBeUndefined();
        expect(pickBotFlair({ features: { authorFlairs: true }, flairs: { author: [{ text: "robotics fan" }] } })).toBeUndefined();
        expect(pickBotFlair({})).toBeUndefined();
    });
});

describe("buildBotAuthor", () => {
    let db: BotDb;
    beforeEach(() => (db = new BotDb(":memory:")));
    afterEach(() => db.close());

    it("always uses the configured name and chains previousCommentCid", () => {
        expect(buildBotAuthor(config, db, {}, undefined)).toEqual({ name: "bitsocialbot.bso", displayName: "Bitsocial Bot" });
        db.setState(PREVIOUS_COMMENT_CID_KEY, "QmPrevious");
        expect(buildBotAuthor(config, db, { displayName: "Custom", name: "evil.eth" } as never, botFlair)).toEqual({
            name: "bitsocialbot.bso",
            displayName: "Custom",
            flairs: [botFlair],
            previousCommentCid: "QmPrevious"
        });
    });
});
