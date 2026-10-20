import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotDb } from "../src/db.js";
import { checkLimits, limitNoticeDue } from "../src/limits.js";
import type { Limits } from "../src/config.js";

const limits: Limits = { communityRepliesPerHour: 2, communityTokensPerDay: 1000, authorMentionsPerHour: 1, globalUsdPerDay: 1, maxBotRepliesInThread: 3, mentionMaxAgeHours: 48, mentionMaxAttempts: 5, retryBaseSeconds: 60, rescanIntervalSeconds: 60 };

const usage = (community: string, tokens: number, costUsd: number) => ({
    community,
    mentionCid: `m${Math.random()}`,
    author: "alice.eth",
    model: "claude-opus-5-5",
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd
});

describe("checkLimits", () => {
    let db: BotDb;
    beforeEach(() => (db = new BotDb(":memory:")));
    afterEach(() => db.close());

    it("allows a fresh mention", () => {
        expect(checkLimits(db, limits, { community: "a.eth", author: "alice.eth" })).toEqual({ ok: true });
    });

    it("enforces the per-author hourly limit", () => {
        db.setMention("m1", "a.eth", "alice.eth", "replied");
        expect(checkLimits(db, limits, { community: "a.eth", author: "alice.eth" }).ok).toBe(false);
        expect(checkLimits(db, limits, { community: "a.eth", author: "bob.eth" }).ok).toBe(true);
    });

    it("does not count rate-limited or skipped mentions", () => {
        db.setMention("m1", "a.eth", "alice.eth", "rate_limited");
        db.setMention("m2", "a.eth", "alice.eth", "skipped");
        expect(checkLimits(db, limits, { community: "a.eth", author: "alice.eth" }).ok).toBe(true);
    });

    it("enforces the per-community hourly limit", () => {
        db.setMention("m1", "a.eth", "u1", "replied");
        db.setMention("m2", "a.eth", "u2", "replied");
        const verdict = checkLimits(db, limits, { community: "a.eth", author: "u3" });
        expect(verdict).toEqual({ ok: false, reason: "community hourly reply limit of 2 reached", scope: "community" });
    });

    it("enforces the community token budget and the global spend cap", () => {
        db.recordUsage(usage("a.eth", 1000, 0.1));
        expect(checkLimits(db, limits, { community: "a.eth", author: "u" }).ok).toBe(false);
        expect(checkLimits(db, limits, { community: "b.eth", author: "u" }).ok).toBe(true);
        db.recordUsage(usage("c.eth", 10, 0.95));
        expect(checkLimits(db, limits, { community: "b.eth", author: "u" })).toEqual({ ok: false, reason: "global daily spend cap of $1 reached", scope: "community" });
    });

    it("reports usage totals per group", () => {
        db.recordUsage(usage("a.eth", 100, 0.01));
        db.recordUsage(usage("a.eth", 50, 0.02));
        db.recordUsage(usage("b.eth", 10, 0.5));
        const totals = db.usageTotals("community", 0);
        expect(totals.map((t) => [t.key, t.calls, t.input_tokens])).toEqual([
            ["b.eth", 1, 10],
            ["a.eth", 2, 150]
        ]);
    });
});

describe("limitNoticeDue", () => {
    let db: BotDb;
    beforeEach(() => (db = new BotDb(":memory:")));
    afterEach(() => db.close());
    const author = { ok: false as const, reason: "author", scope: "author" as const };
    const community = { ok: false as const, reason: "community", scope: "community" as const };

    it("allows one notice an hour per author for their own limit", () => {
        expect(limitNoticeDue(db, author, { community: "a.eth", author: "alice.eth" }, 1000)).toBe(true);
        expect(limitNoticeDue(db, author, { community: "a.eth", author: "alice.eth" }, 2000)).toBe(false);
        expect(limitNoticeDue(db, author, { community: "a.eth", author: "bob.eth" }, 2000)).toBe(true);
        expect(limitNoticeDue(db, author, { community: "a.eth", author: "alice.eth" }, 1000 + 3600)).toBe(true);
    });

    it("allows one notice an hour per community for shared limits, whoever mentions", () => {
        expect(limitNoticeDue(db, community, { community: "a.eth", author: "alice.eth" }, 1000)).toBe(true);
        expect(limitNoticeDue(db, community, { community: "a.eth", author: "bob.eth" }, 1500)).toBe(false);
        expect(limitNoticeDue(db, community, { community: "b.eth", author: "bob.eth" }, 1500)).toBe(true);
    });
});
