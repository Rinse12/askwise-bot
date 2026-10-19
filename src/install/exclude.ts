// Pure helpers for the challenge exclude that "installs" the bot in a community.
// They work on both shapes that carry `exclude`: the owner's private `settings.challenges`
// (written by the install script) and the public `community.challenges` (read by the bot).
//
// The bot is exempted by name, not by public key: the name is owned by an EVM wallet, so a
// leaked signer key can be rotated by re-pointing the name, without any community reinstalling.

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

// Indexes of challenges that would still challenge the bot. Empty means installed
// (also when the community has no challenges at all).
export const challengesMissingBotExclude = (challenges: ChallengeWithExclude[] | undefined, botName: string): number[] =>
    (challenges ?? []).flatMap((challenge, index) => (challengeExemptsBot(challenge, botName) ? [] : [index]));

export interface ExcludeChange<T> {
    challenges: T[];
    changed: number[];
    unchanged: number[];
}

// Idempotent per challenge: running it again after the owner added new challenges only touches the new ones.
export function addBotExclude<T extends ChallengeWithExclude>(challenges: T[], botName: string): ExcludeChange<T> {
    const changed: number[] = [];
    const unchanged: number[] = [];
    const updated = challenges.map((challenge, index) => {
        if (challengeExemptsBot(challenge, botName)) {
            unchanged.push(index);
            return challenge;
        }
        changed.push(index);
        return { ...challenge, exclude: [...(challenge.exclude ?? []), botExcludeItem(botName)] };
    });
    return { challenges: updated, changed, unchanged };
}

export function removeBotExclude<T extends ChallengeWithExclude>(challenges: T[], botName: string): ExcludeChange<T> {
    const changed: number[] = [];
    const unchanged: number[] = [];
    const updated = challenges.map((challenge, index) => {
        if (!challenge.exclude?.some((item) => item.names?.includes(botName))) {
            unchanged.push(index);
            return challenge;
        }
        changed.push(index);
        const exclude = challenge.exclude.flatMap((item) => {
            if (!item.names?.includes(botName)) return [item];
            const names = item.names.filter((name) => name !== botName);
            // An item that only existed for the bot goes away; one shared with other names keeps them
            return names.length > 0 ? [{ ...item, names }] : [];
        });
        const { exclude: _removed, ...rest } = challenge;
        // pkc-js rejects an empty exclude array, so drop the key instead
        return (exclude.length > 0 ? { ...rest, exclude } : rest) as T;
    });
    return { challenges: updated, changed, unchanged };
}

const sameNameLoosely = (a: string, b: string) => a.toLowerCase().replace(/\.eth$/, ".bso") === b.toLowerCase().replace(/\.eth$/, ".bso");

// Why a challenge does not exempt the bot, in words an owner can act on; undefined when it does.
export function diagnoseChallenge(challenge: ChallengeWithExclude, botName: string): string | undefined {
    if (challengeExemptsBot(challenge, botName)) return undefined;
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
    return `it has no exclude for ${botName}`;
}

export interface InstallDiagnosis {
    installed: boolean;
    problems: string[];
}

export function diagnoseInstall(challenges: ChallengeWithExclude[] | undefined, botName: string): InstallDiagnosis {
    const problems = (challenges ?? []).flatMap((challenge, index) => {
        const problem = diagnoseChallenge(challenge, botName);
        const kind = (challenge.type ?? challenge.name ?? challenge.description) as string | undefined;
        return problem ? [`challenge #${index}${kind ? ` (${kind})` : ""}: ${problem}`] : [];
    });
    return { installed: problems.length === 0, problems };
}
