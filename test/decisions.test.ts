// The owner's per-challenge decisions: exempt the bot, or keep checking its replies (a marker item).
import { describe, expect, it } from "vitest";
// pkc-js's own exclude predicate, to prove the marker never exempts anything
import { testPublicationType as pkcTestPublicationType } from "../node_modules/@pkcprotocol/pkc-js/dist/node/runtime/node/community/challenges/exclude/utils.js";
import {
    botExcludeItem,
    botMarkerItem,
    challengeChecksBot,
    diagnoseInstall,
    isBotExcludeItem,
    isBotMarkerItem,
    removeBotExclude,
    setBotDecisions,
    undecidedChallenges,
    type ChallengeWithExclude
} from "../src/install/exclude.js";
import { runInstall, type InstallCommunity, type InstallPkc } from "../src/install/run.js";
import { BOT } from "./fixtures/challenge-scenarios.js";

// Only the publication fields the predicate reads are filled in
const testPublicationType = (publicationType: unknown, request: object): boolean =>
    pkcTestPublicationType(publicationType as Parameters<typeof pkcTestPublicationType>[0], request as Parameters<typeof pkcTestPublicationType>[1]);

const MARKER = botMarkerItem(BOT);

describe("the marker item", () => {
    it("never matches a publication in pkc-js", () => {
        const requests = [
            { comment: { content: "post" } },
            { comment: { content: "reply", parentCid: "Qm" } },
            { vote: {} },
            { commentEdit: {} },
            { commentModeration: {} },
            { communityEdit: {} }
        ];
        for (const request of requests) expect(testPublicationType(MARKER.publicationType, request)).toBe(false);
        // while the exemption does match the bot's replies
        expect(testPublicationType(botExcludeItem(BOT).publicationType, requests[1])).toBe(true);
    });

    it("is told apart from the exemption", () => {
        expect(isBotMarkerItem(MARKER, BOT)).toBe(true);
        expect(isBotExcludeItem(MARKER, BOT)).toBe(false);
        expect(isBotMarkerItem(botExcludeItem(BOT), BOT)).toBe(false);
        expect(isBotMarkerItem({ ...MARKER, postScore: 3 }, BOT)).toBe(false);
        expect(isBotMarkerItem(botMarkerItem("other.bso"), BOT)).toBe(false);
    });
});

describe("setBotDecisions", () => {
    const challenges: ChallengeWithExclude[] = [{ name: "captcha" }, { path: "ai-moderation", exclude: [{ roles: ["owner"] }] }, { name: "new" }];

    it("exempts or marks the decided challenges and leaves the rest undecided", () => {
        const { challenges: updated, changed } = setBotDecisions(challenges, BOT, new Map([[0, true], [1, false]]));
        expect(changed).toEqual([0, 1]);
        expect(updated[0].exclude).toEqual([botExcludeItem(BOT)]);
        expect(updated[1].exclude).toEqual([{ roles: ["owner"] }, MARKER]);
        expect(updated[2]).toEqual({ name: "new" });
        expect(undecidedChallenges(updated, BOT)).toEqual([2]);
        expect(challengeChecksBot(updated[1], BOT)).toBe(true);
    });

    it("flips a decision without touching the owner's own items", () => {
        const marked = setBotDecisions(challenges, BOT, new Map([[1, false]])).challenges;
        const flipped = setBotDecisions(marked, BOT, new Map([[1, true]]));
        expect(flipped.challenges[1].exclude).toEqual([{ roles: ["owner"] }, botExcludeItem(BOT)]);
        expect(setBotDecisions(flipped.challenges, BOT, new Map([[1, true]])).changed).toEqual([]);
    });

    it("is undone by uninstall, marker included", () => {
        const decided = setBotDecisions(challenges, BOT, new Map([[0, true], [1, false]])).challenges;
        expect(removeBotExclude(decided, BOT).challenges).toEqual(challenges);
    });
});

describe("diagnoseInstall with decisions", () => {
    it("is installed once every challenge is decided, and lists the ones still checking the bot", () => {
        const decided = setBotDecisions([{ name: "captcha" }, { name: "ai-moderation" }], BOT, new Map([[0, true], [1, false]])).challenges;
        expect(diagnoseInstall(decided, BOT)).toEqual({ installed: true, problems: [], checkedBy: ["#1 (ai-moderation)"] });
        expect(diagnoseInstall([...decided, { name: "later" }], BOT).installed).toBe(false);
    });
});

function fakeNode(challenges: ChallengeWithExclude[]) {
    const node = { settings: { challenges: structuredClone(challenges) } as { challenges: ChallengeWithExclude[] } };
    const community: InstallCommunity = {
        get settings() {
            return node.settings;
        },
        edit: async ({ settings }) => {
            node.settings = structuredClone(settings) as typeof node.settings;
        }
    };
    const pkc: InstallPkc = { communities: ["memes.bso"], createCommunity: async () => community, getCommunity: async () => ({ address: "memes.bso" }) };
    return { pkc, node };
}

describe("runInstall asking the owner", () => {
    it("asks only about undecided challenges, unless askAll", async () => {
        const { pkc, node } = fakeNode([{ name: "captcha" }, { name: "ai-moderation" }]);
        const asked: number[] = [];
        const decide = async (_: ChallengeWithExclude, index: number) => (asked.push(index), index === 0);
        const report = await runInstall(pkc, { address: "memes.bso", botName: BOT, decide });
        expect(asked).toEqual([0, 1]);
        expect(report.lines).toContain("  challenge #1 (ai-moderation): now checks the bot's replies");
        expect(report.lines.some((line) => line.includes("still go through: #1 (ai-moderation)"))).toBe(true);

        node.settings.challenges.push({ name: "later" });
        asked.length = 0;
        await runInstall(pkc, { address: "memes.bso", botName: BOT, decide });
        expect(asked).toEqual([2]);

        asked.length = 0;
        await runInstall(pkc, { address: "memes.bso", botName: BOT, decide, askAll: true });
        expect(asked).toEqual([0, 1, 2]);
    });

    it("refuses to guess without a way to decide", async () => {
        const { pkc } = fakeNode([{ name: "captcha" }]);
        await expect(runInstall(pkc, { address: "memes.bso", botName: BOT })).rejects.toThrow("needs decide or exemptAll");
    });
});
