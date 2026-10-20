// Shapes settings.challenges can take, shared by the install tests (test/install-*.test.ts).
import { botExcludeItem, type ChallengeWithExclude } from "../../src/install/exclude.js";

export const BOT = "askwise.bso";
export const BOT_ITEM = botExcludeItem(BOT);

export interface Scenario {
    name: string;
    challenges: ChallengeWithExclude[];
    // indexes install must change (append the bot's item); every other challenge must come back untouched
    changes: number[];
    // whether uninstall after install gives back exactly the original (false when the original already
    // exempted the bot, since uninstall then removes that pre-existing exemption too)
    roundTrips: boolean;
}

// Modeled on a production community (business-and-finance.bso): chained `challenges` excludes, roles,
// karma/age/rate-limit, mod publication types, external path challenges and a pendingApproval one.
// Options are made up; the exclude lists are the community's real ones.
export const PRODUCTION_LIKE: ChallengeWithExclude[] = [
    {
        name: "publication-match",
        options: { matches: '[{"propertyName":"author.address","regexp":"\\\\.bso$"}]' },
        exclude: [{ roles: ["moderator", "admin", "owner"] }, { postScore: 3, replyScore: 0, firstCommentTimestamp: 2592000, rateLimit: 2 }, { challenges: [1] }, { challenges: [2] }],
        pendingApproval: false
    },
    { name: "whitelist", options: { addresses: "friend.bso" }, exclude: [{ roles: ["moderator", "admin", "owner"] }, { challenges: [0] }, { challenges: [2] }], pendingApproval: false },
    {
        path: "@bitsocial/spam-blocker-challenge",
        options: { serverUrl: "https://spam-blocker.example" },
        exclude: [{ challenges: [0] }, { challenges: [1] }, { roles: ["owner", "admin", "moderator"] }, { publicationType: { commentModeration: true, communityEdit: true } }],
        pendingApproval: false
    },
    {
        path: "@bitsocial/ai-moderation-challenge",
        options: { model: "example" },
        exclude: [{ challenges: [0] }, { challenges: [1] }, { challenges: [4] }, { roles: ["owner", "admin", "moderator"] }, { publicationType: { commentModeration: true, communityEdit: true } }],
        pendingApproval: false
    },
    {
        path: "@bitsocial/ai-moderation-challenge",
        options: { model: "example", strict: "true" },
        exclude: [{ challenges: [0] }, { challenges: [1] }, { challenges: [3] }, { roles: ["owner", "admin", "moderator"] }, { publicationType: { commentModeration: true, communityEdit: true } }],
        pendingApproval: true
    }
];

export const SCENARIOS: Scenario[] = [
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
        challenges: [{ name: "text-math", exclude: [{ names: ["askwise.eth"] }] }],
        changes: [0],
        roundTrips: true
    },
    {
        name: "the bot with different letter case",
        challenges: [{ name: "text-math", exclude: [{ names: ["AskWise.bso"] }] }],
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
    },
    { name: "a production-like community (business-and-finance.bso)", challenges: PRODUCTION_LIKE, changes: [0, 1, 2, 3, 4], roundTrips: true }
];
