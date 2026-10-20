// Pure helpers for the challenge exclude that "installs" the bot in a community.
// They work on both shapes that carry `exclude`: the owner's private `settings.challenges`
// (written by the install script) and the public `community.challenges` (read by the bot).
//
// The bot is exempted by name, not by public key: the name is owned by an EVM wallet, so a
// leaked signer key can be rotated by re-pointing the name, without any community reinstalling.
//
// The owner decides per challenge whether to exempt the bot. A challenge they chose to keep checking the
// bot with gets a marker item instead: it names the bot but no publication type, so pkc-js never applies
// it. The marker is how the bot tells a challenge the owner decided on from one added after installing.

export interface ChallengeExclude {
    names?: string[];
    publicKeys?: string[];
    publicationType?: Record<string, boolean | undefined>;
    [key: string]: unknown;
}

export interface ChallengeWithExclude {
    exclude?: ChallengeExclude[];
    [key: string]: unknown;
}

export const botExcludeItem = (botName: string): ChallengeExclude => ({
    names: [botName],
    publicationType: { reply: true }
});

// Matches no publication: pkc-js only applies an item whose publicationType has a type set to true.
export const botMarkerItem = (botName: string): ChallengeExclude => ({
    names: [botName],
    publicationType: { reply: false }
});

export const isBotMarkerItem = (item: ChallengeExclude, botName: string): boolean =>
    Array.isArray(item.names) &&
    item.names.includes(botName) &&
    item.publicationType !== undefined &&
    !Object.values(item.publicationType).some(Boolean) &&
    Object.keys(item).every((key) => key === "names" || key === "publicationType" || item[key] === undefined);

// pkc-js compares exclude names to the publication's author.name as exact strings, so neither case nor the
// .bso/.eth spelling may differ from the name the bot publishes with.
//
// An exclude item exempts the bot's replies only if it names the bot and adds no other condition
// (other than limiting it to replies). Within one item every field must match, so e.g.
// `{names: [bot], postScore: 10}` would not reliably exempt the bot.
export function isBotExcludeItem(item: ChallengeExclude, botName: string): boolean {
    if (!Array.isArray(item.names) || !item.names.includes(botName)) return false;
    for (const key of Object.keys(item)) {
        if (key === "names") continue;
        if (key === "publicationType") {
            if (item.publicationType?.reply !== true) return false;
            continue;
        }
        if (item[key] !== undefined) return false;
    }
    return true;
}

export const challengeExemptsBot = (challenge: ChallengeWithExclude, botName: string): boolean =>
    (challenge.exclude ?? []).some((item) => isBotExcludeItem(item, botName));

// The owner chose to keep checking the bot's replies with this challenge
export const challengeChecksBot = (challenge: ChallengeWithExclude, botName: string): boolean =>
    !challengeExemptsBot(challenge, botName) && (challenge.exclude ?? []).some((item) => isBotMarkerItem(item, botName));

const isDecided = (challenge: ChallengeWithExclude, botName: string) => challengeExemptsBot(challenge, botName) || challengeChecksBot(challenge, botName);

// Indexes of challenges the owner has not decided on (neither exempt nor marked). Empty means installed
// (also when the community has no challenges at all).
export const undecidedChallenges = (challenges: ChallengeWithExclude[] | undefined, botName: string): number[] =>
    (challenges ?? []).flatMap((challenge, index) => (isDecided(challenge, botName) ? [] : [index]));

export interface ExcludeChange<T> {
    challenges: T[];
    changed: number[];
    unchanged: number[];
}

const namesBot = (challenge: ChallengeWithExclude, botName: string) => Boolean(challenge.exclude?.some((item) => item.names?.includes(botName)));

function withoutBot<T extends ChallengeWithExclude>(challenge: T, botName: string): T {
    const exclude = (challenge.exclude ?? []).flatMap((item) => {
        if (!item.names?.includes(botName)) return [item];
        const names = item.names.filter((name) => name !== botName);
        // An item that only existed for the bot goes away; one shared with other names keeps them
        return names.length > 0 ? [{ ...item, names }] : [];
    });
    const { exclude: _removed, ...rest } = challenge;
    // pkc-js rejects an empty exclude array, so drop the key instead
    return (exclude.length > 0 ? { ...rest, exclude } : rest) as T;
}

// Applies the owner's decisions, by challenge index: true exempts the bot, false keeps checking it (marker).
// Challenges without a decision are left as they are, and so are those already in the decided state.
export function setBotDecisions<T extends ChallengeWithExclude>(challenges: T[], botName: string, decisions: ReadonlyMap<number, boolean>): ExcludeChange<T> {
    const changed: number[] = [];
    const unchanged: number[] = [];
    const updated = challenges.map((challenge, index) => {
        const exempt = decisions.get(index);
        if (exempt === undefined || (exempt ? challengeExemptsBot(challenge, botName) : challengeChecksBot(challenge, botName))) {
            unchanged.push(index);
            return challenge;
        }
        changed.push(index);
        // Only the bot's own item for the other choice is replaced; items the owner wrote are kept as they are
        const opposite = exempt ? isBotMarkerItem : isBotExcludeItem;
        const kept = (challenge.exclude ?? []).filter((item) => !opposite(item, botName));
        return { ...challenge, exclude: [...kept, exempt ? botExcludeItem(botName) : botMarkerItem(botName)] };
    });
    return { challenges: updated, changed, unchanged };
}

// Exempts the bot from every challenge (install-bot --exempt-all)
export const addBotExclude = <T extends ChallengeWithExclude>(challenges: T[], botName: string): ExcludeChange<T> =>
    setBotDecisions(challenges, botName, new Map(challenges.map((_, index) => [index, true])));

// Removes every item naming the bot, exemptions and markers alike
export function removeBotExclude<T extends ChallengeWithExclude>(challenges: T[], botName: string): ExcludeChange<T> {
    const changed: number[] = [];
    const unchanged: number[] = [];
    const updated = challenges.map((challenge, index) => {
        if (!namesBot(challenge, botName)) {
            unchanged.push(index);
            return challenge;
        }
        changed.push(index);
        return withoutBot(challenge, botName);
    });
    return { challenges: updated, changed, unchanged };
}

const sameNameLoosely = (a: string, b: string) => a.toLowerCase().replace(/\.eth$/, ".bso") === b.toLowerCase().replace(/\.eth$/, ".bso");

// Why a challenge does not exempt the bot, in words an owner can act on; undefined when it does.
export function diagnoseChallenge(challenge: ChallengeWithExclude, botName: string): string | undefined {
    if (isDecided(challenge, botName)) return undefined;
    const items = challenge.exclude ?? [];
    for (const item of items) {
        const misspelled = item.names?.find((name) => name !== botName && sameNameLoosely(name, botName));
        if (misspelled) return `its exclude names "${misspelled}", but it must be exactly "${botName}" (pkc-js compares names exactly)`;
    }
    for (const item of items) {
        if (!item.names?.includes(botName)) continue;
        if (item.publicationType && item.publicationType.reply !== true) return `its exclude for ${botName} does not cover replies (publicationType.reply)`;
        const extra = Object.keys(item).filter((key) => key !== "names" && key !== "publicationType" && item[key] !== undefined);
        if (extra.length > 0) return `its exclude for ${botName} also requires ${extra.join(", ")}, so it does not always apply`;
    }
    return `it neither exempts nor checks ${botName}: the owner has not decided on it`;
}

export interface InstallDiagnosis {
    installed: boolean;
    problems: string[];
    // the challenges the owner chose to keep checking the bot's replies with, e.g. "#3 (ai-moderation)"
    checkedBy: string[];
}

const challengeLabel = (challenge: ChallengeWithExclude, index: number) => {
    const kind = (challenge.type ?? challenge.name ?? challenge.description) as string | undefined;
    return `#${index}${kind ? ` (${kind})` : ""}`;
};

export function diagnoseInstall(challenges: ChallengeWithExclude[] | undefined, botName: string): InstallDiagnosis {
    const problems = (challenges ?? []).flatMap((challenge, index) => {
        const problem = diagnoseChallenge(challenge, botName);
        return problem ? [`challenge ${challengeLabel(challenge, index)}: ${problem}`] : [];
    });
    const checkedBy = (challenges ?? []).flatMap((challenge, index) => (challengeChecksBot(challenge, botName) ? [challengeLabel(challenge, index)] : []));
    return { installed: problems.length === 0, problems, checkedBy };
}
