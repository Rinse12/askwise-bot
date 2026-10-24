// runInstall, the body of `npm run install-bot`, against a fake node that records what gets saved.
import { describe, expect, it } from "vitest";
import { addBotExclude, undecidedChallenges, removeBotExclude, type ChallengeWithExclude } from "../src/install/exclude.js";
import { BOT_FLAIR, runInstall, type BotFlairPlan, type InstallCommunity, type InstallPkc } from "../src/install/run.js";
import { BOT, BOT_ITEM, PRODUCTION_LIKE, SCENARIOS } from "./fixtures/challenge-scenarios.js";

const ADDRESS = "memes.bso";

// Settings fields other than challenges, which must be written back untouched
const OTHER_SETTINGS = { fetchThumbnailUrls: true, fetchThumbnailUrlsProxyUrl: "http://proxy", maxPendingApprovalCount: 50, purgeDisapprovedCommentsOlderThan: 1209600 };

const PUBLIC_KEY = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";

function fakeNode(
    challenges: ChallengeWithExclude[] | undefined,
    options: {
        hosted?: string[];
        noSettings?: boolean;
        failEdit?: boolean;
        unresolvable?: boolean;
        features?: InstallCommunity["features"];
        flairs?: InstallCommunity["flairs"];
    } = {}
) {
    const node = {
        settings: options.noSettings ? undefined : { ...structuredClone(OTHER_SETTINGS), ...(challenges === undefined ? {} : { challenges: structuredClone(challenges) }) },
        features: structuredClone(options.features),
        flairs: structuredClone(options.flairs),
        // settings saved, and features/flairs saved, one entry per edit that carried them
        edits: [] as Record<string, unknown>[],
        flairEdits: [] as { features?: unknown; flairs?: unknown }[]
    };
    const community: InstallCommunity = {
        get settings() {
            return node.settings as InstallCommunity["settings"];
        },
        get features() {
            return node.features;
        },
        get flairs() {
            return node.flairs;
        },
        edit: async ({ settings, features, flairs }) => {
            if (options.failEdit) throw new Error("ERR_INVALID_SETTINGS");
            if (settings) {
                node.edits.push(structuredClone(settings));
                node.settings = structuredClone(settings) as typeof node.settings;
            }
            if (features || flairs) {
                node.flairEdits.push(structuredClone({ features, flairs }));
                node.features = structuredClone(features) as typeof node.features;
                node.flairs = structuredClone(flairs) as typeof node.flairs;
            }
        }
    };
    const opened: string[] = [];
    const pkc: InstallPkc = {
        communities: options.hosted ?? [ADDRESS],
        createCommunity: async ({ address }) => {
            opened.push(address);
            return community;
        },
        getCommunity: async ({ address }) => {
            if (options.unresolvable) throw new Error("ERR_FAILED_TO_RESOLVE");
            // the community is known both as memes.bso and by its public key
            if (address !== ADDRESS && address !== PUBLIC_KEY) throw new Error("ERR_NOT_FOUND");
            return { address: ADDRESS, name: ADDRESS, publicKey: PUBLIC_KEY };
        }
    };
    return { pkc, node, opened };
}

const install = (pkc: InstallPkc, extra: { uninstall?: boolean; dryRun?: boolean } = {}) => runInstall(pkc, { address: ADDRESS, botName: BOT, exemptAll: true, ...extra });

describe("runInstall: refuses what it cannot do", () => {
    it("a community the node does not host", async () => {
        const { pkc, node } = fakeNode([{ name: "text-math" }], { hosted: ["other.bso", "12D3KooWabc"] });
        await expect(runInstall(pkc, { address: ADDRESS, botName: BOT, exemptAll: true, rpcLabel: "ws://localhost:9138" })).rejects.toThrow(
            "memes.bso is not hosted by the node at ws://localhost:9138. Hosted communities: other.bso, 12D3KooWabc"
        );
        expect(node.edits).toEqual([]);
    });

    it("a community whose address cannot be resolved", async () => {
        const { pkc } = fakeNode([{ name: "text-math" }], { hosted: [PUBLIC_KEY], unresolvable: true });
        await expect(install(pkc)).rejects.toThrow(`memes.bso is not hosted by the node. Hosted communities: ${PUBLIC_KEY}`);
    });

    it("a node that hosts nothing", async () => {
        const { pkc } = fakeNode([], { hosted: [] });
        await expect(install(pkc)).rejects.toThrow("Hosted communities: none");
    });

    it("a community whose settings cannot be read", async () => {
        const { pkc, node } = fakeNode([{ name: "text-math" }], { noSettings: true });
        await expect(install(pkc)).rejects.toThrow("could not read the settings of memes.bso");
        expect(node.edits).toEqual([]);
    });

    it("reports a failed save instead of claiming success", async () => {
        const { pkc } = fakeNode([{ name: "text-math" }], { failEdit: true });
        await expect(install(pkc)).rejects.toThrow("ERR_INVALID_SETTINGS");
    });
});

describe("runInstall: finds the hosted community by name or public key", () => {
    it("given its name while the node lists it by public key (e.g. named after it was created)", async () => {
        const { pkc, node, opened } = fakeNode([{ name: "text-math" }], { hosted: ["other.bso", PUBLIC_KEY] });
        const report = await install(pkc);
        expect(opened).toEqual([PUBLIC_KEY]);
        expect(report.saved).toBe(true);
        expect(node.edits).toHaveLength(1);
    });

    it("given its public key while the node lists it by name", async () => {
        const { pkc, opened } = fakeNode([{ name: "text-math" }], { hosted: [ADDRESS] });
        const report = await runInstall(pkc, { address: PUBLIC_KEY, botName: BOT, exemptAll: true });
        expect(opened).toEqual([ADDRESS]);
        expect(report.saved).toBe(true);
    });

    it("given the identifier the node lists, without resolving anything", async () => {
        const { pkc, opened } = fakeNode([{ name: "text-math" }], { unresolvable: true });
        await install(pkc);
        expect(opened).toEqual([ADDRESS]);
    });
});

describe("runInstall: what gets saved", () => {
    it.each(SCENARIOS)("$name: saves exactly the original settings plus the bot's items, only when needed", async ({ challenges, changes }) => {
        const { pkc, node } = fakeNode(challenges);
        const report = await install(pkc);
        expect(report.changed).toEqual(changes);
        if (changes.length === 0) {
            expect(node.edits).toEqual([]);
            expect(report.saved).toBe(false);
            expect(report.lines).toContain("No changes needed.");
            return;
        }
        expect(node.edits).toHaveLength(1);
        expect(node.edits[0]).toEqual({ ...OTHER_SETTINGS, challenges: addBotExclude(challenges, BOT).challenges });
        expect(undecidedChallenges(node.edits[0].challenges as ChallengeWithExclude[], BOT)).toEqual([]);
        expect(report.saved).toBe(true);
    });

    it.each(SCENARIOS)("$name: running it again saves nothing", async ({ challenges }) => {
        const { pkc, node } = fakeNode(challenges);
        await install(pkc);
        const editsAfterFirst = node.edits.length;
        const second = await install(pkc);
        expect(node.edits).toHaveLength(editsAfterFirst);
        expect(second.changed).toEqual([]);
        expect(second.saved).toBe(false);
    });

    it.each(SCENARIOS)("$name: uninstall after install leaves no exemption for the bot", async ({ challenges, roundTrips }) => {
        const { pkc, node } = fakeNode(challenges);
        await install(pkc);
        await install(pkc, { uninstall: true });
        const final = (node.settings!.challenges ?? []) as ChallengeWithExclude[];
        expect(undecidedChallenges(final, BOT)).toEqual(final.map((_, index) => index));
        expect(final).toEqual(removeBotExclude(addBotExclude(challenges, BOT).challenges, BOT).challenges);
        if (roundTrips && challenges.every((challenge) => challenge.exclude?.length !== 0)) expect(final).toEqual(challenges);
        expect({ ...node.settings, challenges: undefined }).toEqual({ ...OTHER_SETTINGS, challenges: undefined });
    });

    it("a community with no challenges at all: nothing to do", async () => {
        const { pkc, node } = fakeNode([]);
        const report = await install(pkc);
        expect(node.edits).toEqual([]);
        expect(report.lines[0]).toBe("memes.bso has no challenges, so askwise.bso can already publish.");
        expect(report.lines).toContain("No changes needed.");
    });

    it("settings without a challenges key: nothing to do, and no challenges key is invented", async () => {
        const { pkc, node } = fakeNode(undefined);
        await install(pkc);
        expect(node.edits).toEqual([]);
        expect("challenges" in node.settings!).toBe(false);
    });

    it("a challenge added after installing gets the exemption on the next run, the old ones are untouched", async () => {
        const { pkc, node } = fakeNode([{ name: "question", options: { question: "q?", answer: "a" } }]);
        await install(pkc);
        const afterFirst = structuredClone(node.settings!.challenges as ChallengeWithExclude[]);
        node.settings!.challenges = [...afterFirst, { name: "text-math", exclude: [{ roles: ["moderator"] }] }];
        const report = await install(pkc);
        expect(report.changed).toEqual([1]);
        expect(report.unchanged).toEqual([0]);
        const saved = node.edits.at(-1)!.challenges as ChallengeWithExclude[];
        expect(saved[0]).toEqual(afterFirst[0]);
        expect(saved[1]).toEqual({ name: "text-math", exclude: [{ roles: ["moderator"] }, BOT_ITEM] });
    });
});

describe("runInstall: dry run", () => {
    it("shows the would-be challenges and saves nothing", async () => {
        const { pkc, node } = fakeNode(PRODUCTION_LIKE);
        const report = await install(pkc, { dryRun: true });
        expect(node.edits).toEqual([]);
        expect(report.saved).toBe(false);
        expect(report.changed).toEqual([0, 1, 2, 3, 4]);
        const shown = JSON.parse(report.lines.slice(report.lines.indexOf("--dry-run: new settings.challenges would be:") + 1).join("\n"));
        expect(shown).toEqual(addBotExclude(PRODUCTION_LIKE, BOT).challenges);
        expect(report.lines.join("\n")).not.toContain("Next step");
    });

    it("dry-run uninstall saves nothing either", async () => {
        const installed = addBotExclude(PRODUCTION_LIKE, BOT).challenges;
        const { pkc, node } = fakeNode(installed);
        const report = await install(pkc, { uninstall: true, dryRun: true });
        expect(node.edits).toEqual([]);
        expect(report.changed).toEqual([0, 1, 2, 3, 4]);
        expect(node.settings!.challenges).toEqual(installed);
    });
});

describe("runInstall: uninstall", () => {
    it("a community that never installed the bot: nothing saved", async () => {
        const { pkc, node } = fakeNode(PRODUCTION_LIKE);
        const report = await install(pkc, { uninstall: true });
        expect(node.edits).toEqual([]);
        expect(report.lines).toContain("No changes needed.");
    });

    it("says the bot will stop answering only when something was removed", async () => {
        const { pkc } = fakeNode(addBotExclude(PRODUCTION_LIKE, BOT).challenges);
        const report = await install(pkc, { uninstall: true });
        expect(report.lines.at(-1)).toBe("askwise.bso will stop answering in memes.bso on its next update.");
    });
});

describe("runInstall: output", () => {
    it("names each challenge by name or path and points to the registry", async () => {
        const { pkc } = fakeNode(PRODUCTION_LIKE);
        const report = await runInstall(pkc, { address: ADDRESS, botName: BOT, exemptAll: true, registryAddress: "registry.askwise.bso" });
        expect(report.lines).toContain("  challenge #0 (publication-match): now exempts the bot");
        expect(report.lines).toContain("  challenge #2 (@bitsocial/spam-blocker-challenge): now exempts the bot");
        expect(report.lines.at(-1)).toMatch(/registry community \(registry\.askwise\.bso\) from the owner or an admin account, containing just: memes\.bso$/);
    });

    it("uses the bot name it is given, exactly as given", async () => {
        const { pkc, node } = fakeNode([{ name: "text-math" }]);
        await runInstall(pkc, { address: ADDRESS, botName: "mybot.bso", exemptAll: true });
        expect((node.edits[0].challenges as ChallengeWithExclude[])[0].exclude).toEqual([{ names: ["mybot.bso"], publicationType: { reply: true } }]);
    });
});

describe("runInstall: bot flair", () => {
    const QUESTION = [{ name: "question", options: { question: "q?", answer: "a" } }];

    it("asks when the community has none, and saves the flair together with the exemption in one edit", async () => {
        const { pkc, node } = fakeNode(QUESTION, { features: { noVideos: true }, flairs: { post: [{ text: "news" }] } });
        const plans: BotFlairPlan[] = [];
        const report = await runInstall(pkc, {
            address: ADDRESS,
            botName: BOT,
            exemptAll: true,
            decideBotFlair: async (plan) => (plans.push(plan), true)
        });
        expect(plans).toEqual([{ enablesAuthorFlairs: true, existingAuthorFlairs: [] }]);
        expect(node.edits).toHaveLength(1);
        // the other features and flair lists are written back, since pkc-js replaces them as a whole
        expect(node.flairEdits).toEqual([{ features: { noVideos: true, authorFlairs: true }, flairs: { post: [{ text: "news" }], author: [BOT_FLAIR] } }]);
        expect(report.addedBotFlair).toBe(true);
    });

    it("tells the owner which flairs everyone could pick once author flairs are turned on", async () => {
        const { pkc, node } = fakeNode([], { flairs: { author: [{ text: "OG" }] } });
        const plans: BotFlairPlan[] = [];
        await runInstall(pkc, { address: ADDRESS, botName: BOT, exemptAll: true, decideBotFlair: async (plan) => (plans.push(plan), true) });
        expect(plans).toEqual([{ enablesAuthorFlairs: true, existingAuthorFlairs: ["OG"] }]);
        expect(node.flairEdits[0].flairs).toEqual({ author: [{ text: "OG" }, BOT_FLAIR] });
    });

    it("declined: saves only the challenges and says how to add it later", async () => {
        const { pkc, node } = fakeNode(QUESTION);
        const report = await runInstall(pkc, { address: ADDRESS, botName: BOT, exemptAll: true, decideBotFlair: async () => false });
        expect(node.flairEdits).toEqual([]);
        expect(node.edits).toHaveLength(1);
        expect(report.lines.join("\n")).toContain("--bot-flair");
    });

    it("--bot-flair adds it without asking, even when nothing else changes", async () => {
        const { pkc, node } = fakeNode([]);
        const report = await runInstall(pkc, { address: ADDRESS, botName: BOT, exemptAll: true, botFlair: true, decideBotFlair: async () => expect.fail("asked") });
        expect(node.edits).toEqual([]);
        expect(node.flairEdits).toHaveLength(1);
        expect(report.saved).toBe(true);
    });

    it("an offered bot flair is left alone and not asked about", async () => {
        const offered = { features: { authorFlairs: true }, flairs: { author: [{ text: "bots" }] } };
        const { pkc, node } = fakeNode([], offered);
        const report = await runInstall(pkc, { address: ADDRESS, botName: BOT, exemptAll: true, decideBotFlair: async () => expect.fail("asked") });
        expect(node.flairEdits).toEqual([]);
        expect(report.lines).toContain(`  bot flair: ${BOT}'s replies show "bots"`);
    });

    it("a listed bot flair with the feature off: turns the feature on without adding a second flair", async () => {
        const { pkc, node } = fakeNode([], { features: { authorFlairs: false }, flairs: { author: [{ text: "Bot" }] } });
        await runInstall(pkc, { address: ADDRESS, botName: BOT, exemptAll: true, botFlair: true });
        expect(node.flairEdits).toEqual([{ features: { authorFlairs: true }, flairs: { author: [{ text: "Bot" }] } }]);
    });

    it("dry run shows the flair change and saves nothing", async () => {
        const { pkc, node } = fakeNode(QUESTION);
        const report = await runInstall(pkc, { address: ADDRESS, botName: BOT, exemptAll: true, botFlair: true, dryRun: true });
        expect(node.flairEdits).toEqual([]);
        expect(report.lines).toContain("--dry-run: new features and flairs would be:");
    });

    it("uninstall leaves the flair and says so", async () => {
        const { pkc, node } = fakeNode(addBotExclude(QUESTION, BOT).challenges, { features: { authorFlairs: true }, flairs: { author: [BOT_FLAIR] } });
        const report = await install(pkc, { uninstall: true });
        expect(node.flairEdits).toEqual([]);
        expect(report.lines.at(-1)).toContain("still listed in flairs.author");
    });
});
