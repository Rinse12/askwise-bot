import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotDb } from "../src/db.js";

const usage = (community: string, mentionCid: string, inputTokens: number, outputTokens: number, costUsd: number) => ({
    community,
    mentionCid,
    author: "alice.eth",
    model: "claude-haiku-5-5",
    inputTokens,
    outputTokens,
    cacheReadTokens: 10,
    cacheWriteTokens: 0,
    costUsd
});

describe("dashboard reports", () => {
    let db: BotDb;
    beforeEach(() => (db = new BotDb(":memory:")));
    afterEach(() => db.close());

    it("lists installed communities and ones that only had mentions, with their totals", () => {
        db.installCommunity("a.bso", "owner", null);
        db.installCommunity("idle.bso", "owner", null);
        db.setMention("m1", "a.bso", "alice.eth", "replied", { replyCid: "r1" });
        db.setMention("m2", "a.bso", "bob.eth", "failed", { reason: "boom" });
        db.setMention("m3", "registry.bso", "carol.eth", "replied", { replyCid: "r3" });
        db.recordUsage(usage("a.bso", "m1", 100, 50, 0.01));
        db.recordUsage(usage("a.bso", "m2", 40, 0, 0.002));

        const reports = Object.fromEntries(db.communityReports(0).map((row) => [row.address, row]));
        expect(reports["a.bso"]).toMatchObject({ status: "installed", mentions: 2, replied: 1, failed: 1, calls: 2, input_tokens: 160, output_tokens: 50, cache_read_tokens: 20 });
        expect(reports["a.bso"].cost_usd).toBeCloseTo(0.012);
        expect(reports["idle.bso"]).toMatchObject({ status: "installed", mentions: 0, calls: 0, cost_usd: 0, last_mention_at: null });
        expect(reports["registry.bso"]).toMatchObject({ status: null, installed_at: null, mentions: 1, replied: 1 });
    });

    it("sums every LLM call of a mention, refusals and retries included", () => {
        db.setMention("m1", "a.bso", "alice.eth", "replied", { replyCid: "r1", comment: { content: "@bot hi" } });
        db.setMention("m2", "a.bso", "alice.eth", "skipped", { reason: "too old" });
        db.recordUsage(usage("a.bso", "m1", 100, 5, 0.001));
        db.recordUsage(usage("a.bso", "m1", 100, 50, 0.01));

        const [first, second] = db.mentionReports(0, 10).sort((a, b) => a.cid.localeCompare(b.cid));
        expect(first).toMatchObject({ cid: "m1", status: "replied", reply_cid: "r1", calls: 2, input_tokens: 220, output_tokens: 55 });
        expect(JSON.parse(first.comment_json!)).toEqual({ content: "@bot hi" });
        expect(second).toMatchObject({ cid: "m2", status: "skipped", reason: "too old", calls: 0, input_tokens: 0, cost_usd: 0 });
    });

    it("leaves out mentions and usage before the period", () => {
        db.setMention("m1", "a.bso", "alice.eth", "replied");
        db.recordUsage(usage("a.bso", "m1", 100, 50, 0.01));
        const future = Math.floor(Date.now() / 1000) + 60;
        expect(db.mentionReports(future, 10)).toEqual([]);
        expect(db.dailyReports(future)).toEqual([]);
        expect(db.communityReports(future)[0]).toMatchObject({ mentions: 0, calls: 0 });
        expect(db.dailyReports(0)).toEqual([{ day: new Date().toISOString().slice(0, 10), calls: 1, tokens: 160, cost_usd: 0.01 }]);
    });
});
