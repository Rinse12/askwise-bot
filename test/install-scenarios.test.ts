// The install script's core (addBotExclude / removeBotExclude) against the shapes settings.challenges
// can take in pkc-js. The same matrix runs against a real community in the e2e test (test/e2e/run.ts).
import { describe, expect, it } from "vitest";
import { addBotExclude, botExcludeItem, challengesMissingBotExclude, removeBotExclude, type ChallengeWithExclude } from "../src/install/exclude.js";

const BOT = "bitsocialbot.bso";
const BOT_ITEM = botExcludeItem(BOT);
const clone = <T>(value: T): T => structuredClone(value);

interface Scenario {
    name: string;
    challenges: ChallengeWithExclude[];
    // indexes install must change (append the bot's item); every other challenge must come back untouched
    changes: number[];
    // whether uninstall after install gives back exactly the original (false when the original already
    // exempted the bot, since uninstall then removes that pre-existing exemption too)
    roundTrips: boolean;
}

const SCENARIOS: Scenario[] = [
    { name: "no challenges", challenges: [], changes: [], roundTrips: true },
    { name: "a challenge without exclude", challenges: [{ name: "question", options: { question: "q?", answer: "a" } }], changes: [0], roundTrips: true },
    {
        name: "an exclude for roles",
        challenges: [{ name: "text-math", exclude: [{ roles: ["owner", "admin", "moderator"] }] }],
        changes: [0],
        roundTrips: true
    },
    {
        name: "an exclude for other names (kept separate, never merged into)",
        challenges: [{ name: "text-math", exclude: [{ names: ["friend.bso", "other.bso"] }] }],
        changes: [0],
        roundTrips: true
    },
    {
        name: "an exclude for other names with conditions",
        challenges: [{ name: "text-math", exclude: [{ names: ["friend.bso"], postScore: 10, publicationType: { post: true } }] }],
        changes: [0],
        roundTrips: true
    },
    {
        name: "an exclude for public keys",
        challenges: [{ name: "text-math", exclude: [{ publicKeys: ["12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y"] }] }],
        changes: [0],
        roundTrips: true
    },
    {
        name: "excludes on karma, account age, rate limit and other challenges",
        challenges: [
            { name: "question", options: { question: "q?", answer: "a" } },
            {
                name: "text-math",
                exclude: [
                    { postScore: 100, replyScore: 50 },
                    { firstCommentTimestamp: 2592000, postCount: 3 },
                    { rateLimit: 2, rateLimitChallengeSuccess: true },
                    { challenges: [0] },
                    { community: { addresses: ["friendly.bso"], maxCommentCids: 3, postScore: 10 } }
                ]
            }
        ],
        changes: [0, 1],
        roundTrips: true
    },
    {
        name: "the bot already exempt (previous install)",
        challenges: [{ name: "question", options: { question: "q?", answer: "a" }, exclude: [{ roles: ["owner"] }, BOT_ITEM] }],
        changes: [],
        roundTrips: false
    },
    {
        name: "the bot listed among other names, with no conditions",
        challenges: [{ name: "text-math", exclude: [{ names: ["friend.bso", BOT] }] }],
        changes: [],
        roundTrips: false
    },
    {
        name: "the bot exempt for replies and posts",
        challenges: [{ name: "text-math", exclude: [{ names: [BOT], publicationType: { reply: true, post: true } }] }],
        changes: [],
        roundTrips: false
    },
    {
        name: "the bot misspelled as .eth",
        challenges: [{ name: "text-math", exclude: [{ names: ["bitsocialbot.eth"] }] }],
        changes: [0],
        roundTrips: true
    },
    {
        name: "the bot with different letter case",
        challenges: [{ name: "text-math", exclude: [{ names: ["BitsocialBot.bso"] }] }],
        changes: [0],
        roundTrips: true
    },
    {
        name: "the bot named with an extra condition",
        challenges: [{ name: "text-math", exclude: [{ names: [BOT], postScore: 10 }] }],
        changes: [0],
        roundTrips: false
    },
    {
        name: "the bot named for posts only",
        challenges: [{ name: "text-math", exclude: [{ names: [BOT], publicationType: { post: true } }] }],
        changes: [0],
        roundTrips: false
    },
    {
        name: "the bot named together with a public key in one item",
        challenges: [{ name: "text-math", exclude: [{ names: [BOT], publicKeys: ["12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y"] }] }],
        changes: [0],
        roundTrips: false
    },
    { name: "an empty exclude array", challenges: [{ name: "text-math", exclude: [] }], changes: [0], roundTrips: false },
    {
        name: "challenge fields other than exclude (path, options, pendingApproval, description, publicOptions)",
        challenges: [
            {
                path: "/opt/challenges/custom.js",
                options: { a: "1", b: "2" },
                pendingApproval: true,
                description: "custom",
                publicOptions: ["a"]
            },
            { name: "blacklist", options: { addresses: "spammer.bso", error: "no" } }
        ],
        changes: [0, 1],
        roundTrips: true
    },
    {
        name: "a mix of installed and new challenges (challenges added after installing)",
        challenges: [
            { name: "question", options: { question: "q?", answer: "a" }, exclude: [BOT_ITEM] },
            { name: "text-math" },
            { name: "publication-match", options: { matches: '[{"propertyName":"author.address","regexp":"\\\\.bso$"}]' }, exclude: [{ roles: ["moderator"] }] },
            { name: "text-math", exclude: [{ names: ["friend.bso", BOT] }] }
        ],
        changes: [1, 2],
        roundTrips: false
    },
    {
        name: "two identical challenges",
        challenges: [{ name: "text-math" }, { name: "text-math" }],
        changes: [0, 1],
        roundTrips: true
    }
];

describe.each(SCENARIOS)("install with $name", ({ challenges, changes, roundTrips }) => {
    const original = clone(challenges);
    const installed = addBotExclude(challenges, BOT);

    it("does not mutate the input", () => {
        addBotExclude(challenges, BOT);
        expect(challenges).toEqual(original);
    });

    it("appends the bot's item only to the challenges that need it, keeping everything else as it was", () => {
        expect(installed.changed).toEqual(changes);
        expect(installed.challenges).toHaveLength(original.length);
        installed.challenges.forEach((challenge, index) => {
            if (!changes.includes(index)) return expect(challenge).toEqual(original[index]);
            const { exclude, ...rest } = challenge;
            const { exclude: originalExclude, ...originalRest } = original[index];
            expect(rest).toEqual(originalRest);
            expect(exclude).toEqual([...(originalExclude ?? []), BOT_ITEM]);
        });
    });

    it("leaves the bot exempt from every challenge", () => {
        expect(challengesMissingBotExclude(installed.challenges, BOT)).toEqual([]);
    });

    it("changes nothing when run again", () => {
        const again = addBotExclude(installed.challenges, BOT);
        expect(again.changed).toEqual([]);
        expect(again.challenges).toEqual(installed.challenges);
    });

    it("never produces an empty exclude array (pkc-js rejects one)", () => {
        for (const challenge of [...installed.challenges, ...removeBotExclude(installed.challenges, BOT).challenges])
            if ("exclude" in challenge) expect(challenge.exclude!.length).toBeGreaterThan(0);
    });

    it(roundTrips ? "uninstall restores the original exactly" : "uninstall removes every exemption for the bot", () => {
        const uninstalled = removeBotExclude(installed.challenges, BOT).challenges;
        if (roundTrips) expect(uninstalled).toEqual(original.map((challenge) => (challenge.exclude?.length === 0 ? (({ exclude: _e, ...rest }) => rest)(challenge) : challenge)));
        // whatever the original was, nothing exempts the bot by its exact name anymore
        for (const challenge of uninstalled) for (const item of challenge.exclude ?? []) expect(item.names ?? []).not.toContain(BOT);
        expect(challengesMissingBotExclude(uninstalled, BOT)).toEqual(uninstalled.map((_, index) => index));
    });
});

describe("uninstall safety", () => {
    it("drops an item that only named the bot, instead of leaving its conditions to exempt everyone", () => {
        // {postScore: 10} without names would exempt every author with that score
        const { challenges } = removeBotExclude([{ exclude: [{ names: [BOT], postScore: 10 }, { roles: ["owner"] }] }], BOT);
        expect(challenges).toEqual([{ exclude: [{ roles: ["owner"] }] }]);
    });

    it("keeps other names and conditions of a shared item", () => {
        const { challenges } = removeBotExclude([{ exclude: [{ names: ["friend.bso", BOT], postScore: 10 }] }], BOT);
        expect(challenges).toEqual([{ exclude: [{ names: ["friend.bso"], postScore: 10 }] }]);
    });

    it("leaves a community that never installed the bot as it is", () => {
        const original = [{ name: "text-math" }, { name: "question", exclude: [{ names: ["friend.bso"] }] }];
        const { challenges, changed } = removeBotExclude(clone(original), BOT);
        expect(changed).toEqual([]);
        expect(challenges).toEqual(original);
    });
});
