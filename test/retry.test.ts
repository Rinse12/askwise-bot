import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotDb } from "../src/db.js";
import { isTooOld, nextAttemptAt } from "../src/retry.js";

const limits = { mentionMaxAgeHours: 48, mentionMaxAttempts: 5, retryBaseSeconds: 60 };
const NOW = 1_800_000_000;

describe("nextAttemptAt", () => {
    it("backs off failed attempts exponentially and gives up after the max", () => {
        const at = (attempts: number) => nextAttemptAt({ kind: "failed", attempts, retryable: true }, NOW, limits, NOW);
        expect([1, 2, 3, 4].map((n) => at(n)! - NOW)).toEqual([60, 120, 240, 480]);
        expect(at(5)).toBeUndefined();
    });
    it("does not retry what cannot succeed", () => {
        expect(nextAttemptAt({ kind: "failed", attempts: 1, retryable: false }, NOW, limits, NOW)).toBeUndefined();
    });
    it("retries rate-limited mentions every 10x base", () => {
        expect(nextAttemptAt({ kind: "rate_limited" }, NOW, limits, NOW)).toBe(NOW + 600);
    });
    it("stops retrying once the mention would be too old", () => {
        const almostTooOld = NOW - 48 * 3600 + 30;
        expect(nextAttemptAt({ kind: "rate_limited" }, almostTooOld, limits, NOW)).toBeUndefined();
        expect(isTooOld(NOW - 48 * 3600 - 1, limits, NOW)).toBe(true);
        expect(isTooOld(NOW - 3600, limits, NOW)).toBe(false);
    });
});

describe("mention retries in the db", () => {
    let db: BotDb;
    beforeEach(() => (db = new BotDb(":memory:")));
    afterEach(() => db.close());

    it("counts failed attempts and returns due retries with their comment, oldest first", () => {
        const comment = { cid: "m1", timestamp: NOW, content: "@bitsocialbot ?" };
        db.setMention("m1", "a.bso", "alice.bso", "replying", { comment });
        db.setMention("m1", "a.bso", "alice.bso", "failed", { reason: "offline", retryAt: NOW + 60 });
        db.setMention("m1", "a.bso", "alice.bso", "failed", { reason: "offline", retryAt: NOW + 120 });
        expect(db.getMention("m1")).toMatchObject({ status: "failed", attempts: 2 });
        expect(db.dueRetries("a.bso", NOW + 119)).toEqual([]);
        expect(db.dueRetries("a.bso", NOW + 120)).toEqual([{ cid: "m1", comment }]);
        expect(db.dueRetries("b.bso", NOW + 120)).toEqual([]);

        db.setMention("m1", "a.bso", "alice.bso", "replied", { replyCid: "r1" });
        expect(db.dueRetries("a.bso", NOW + 1000)).toEqual([]);
    });

    it("never retries a mention scheduled without retryAt", () => {
        db.setMention("m2", "a.bso", "bob.bso", "failed", { reason: "refused", comment: { cid: "m2" } });
        expect(db.dueRetries("a.bso", NOW * 2)).toEqual([]);
    });

    it("turns mentions interrupted mid-reply into immediate retries", () => {
        db.setMention("m3", "a.bso", "carol.bso", "replying", { comment: { cid: "m3" } });
        db.setMention("m4", "a.bso", "dave.bso", "replied", { replyCid: "r4", comment: { cid: "m4" } });
        expect(db.retryInterruptedMentions()).toBe(1);
        expect(db.getMention("m3")?.status).toBe("failed");
        expect(db.dueRetries("a.bso", Math.floor(Date.now() / 1000)).map((due) => due.cid)).toEqual(["m3"]);
    });
});

describe("isBotReply", () => {
    it("recognizes the bot's replies by cid, e.g. under a pseudonymity alias", () => {
        const db = new BotDb(":memory:");
        db.setMention("m1", "a.bso", "alice.bso", "replied", { replyCid: "QmBotReply" });
        expect(db.isBotReply("QmBotReply")).toBe(true);
        expect(db.isBotReply("m1")).toBe(false);
        db.close();
    });
});
