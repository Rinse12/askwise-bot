// The install script's core (addBotExclude / removeBotExclude) against the shapes settings.challenges
// can take in pkc-js. The same matrix runs against a real community in the e2e test (test/e2e/run.ts).
import { describe, expect, it } from "vitest";
import { addBotExclude, challengesMissingBotExclude, removeBotExclude } from "../src/install/exclude.js";
import { BOT, BOT_ITEM, SCENARIOS } from "./fixtures/challenge-scenarios.js";

const clone = <T>(value: T): T => structuredClone(value);

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
