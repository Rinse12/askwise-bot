import { isBotFlair, pickBotFlair } from "../author.js";
import { challengeChecksBot, challengeExemptsBot, removeBotExclude, setBotDecisions, undecidedChallenges, type ChallengeWithExclude } from "./exclude.js";

// The slice of a pkc instance the install needs, so it can be tested without a node
export interface InstallPkc {
    communities: string[];
    createCommunity(options: { address: string }): Promise<InstallCommunity>;
    getCommunity(options: { address: string }): Promise<{ address?: string; name?: string; publicKey?: string }>;
}

export interface InstallCommunity {
    settings?: { challenges?: unknown[]; [key: string]: unknown };
    features?: { authorFlairs?: boolean; [key: string]: unknown };
    flairs?: { author?: { text: string }[]; [key: string]: unknown };
    edit(options: { settings?: Record<string, unknown>; features?: Record<string, unknown>; flairs?: Record<string, unknown> }): Promise<unknown>;
}

// Asks the owner whether to exempt the bot from one challenge: true exempts it, false keeps checking its replies
export type DecideChallenge = (challenge: ChallengeWithExclude, index: number) => Promise<boolean>;

// What adding the bot flair would change, so the owner can be told before deciding
export interface BotFlairPlan {
    // features.authorFlairs is off, so adding the flair also lets every author pick their own flair
    enablesAuthorFlairs: boolean;
    // the author flairs the community already lists (any author could pick these once the feature is on)
    existingAuthorFlairs: string[];
}

// Asks the owner whether to offer a bot author flair, so the bot's replies show a bot badge
export type DecideBotFlair = (plan: BotFlairPlan) => Promise<boolean>;

export const BOT_FLAIR = { text: "🤖 bot" };

export interface InstallOptions {
    address: string;
    botName: string;
    // how each challenge is decided: asked with `decide`, or all exempted with `exemptAll`
    decide?: DecideChallenge;
    exemptAll?: boolean;
    // ask again about challenges already decided (by default only undecided ones are asked about)
    askAll?: boolean;
    // the optional bot badge: added when botFlair is true, else asked with decideBotFlair, else only suggested
    botFlair?: boolean;
    decideBotFlair?: DecideBotFlair;
    uninstall?: boolean;
    dryRun?: boolean;
    rpcLabel?: string;
    registryAddress?: string;
}

export interface InstallReport {
    lines: string[];
    changed: number[];
    addedBotFlair: boolean;
    unchanged: number[];
    challenges: ChallengeWithExclude[];
    saved: boolean;
}

// The node lists each community it hosts under one identifier (e.g. its public key, even after it was given a
// name), while the owner may type the other one; resolve the community to match either.
async function findHostedAddress(pkc: InstallPkc, address: string): Promise<string | undefined> {
    if (pkc.communities.includes(address)) return address;
    try {
        const community = await pkc.getCommunity({ address });
        return [community.publicKey, community.name, community.address].find((candidate) => candidate && pkc.communities.includes(candidate));
    } catch {
        return undefined;
    }
}

export const describeChallenge = (challenge: ChallengeWithExclude) => String(challenge.name ?? challenge.path ?? "unnamed");

// Records the owner's decision for each challenge of a community hosted by this node: exempt the bot, or keep
// checking its replies (or with uninstall, removes both). Only challenges that need it are touched, every other
// setting is written back as it was, and nothing is saved when nothing changes or on a dry run.
export async function runInstall(pkc: InstallPkc, options: InstallOptions): Promise<InstallReport> {
    const { address, botName, uninstall = false, dryRun = false } = options;
    if (!uninstall && !options.decide && !options.exemptAll) throw new Error("runInstall needs decide or exemptAll");
    const where = options.rpcLabel ? ` at ${options.rpcLabel}` : "";
    const hostedAddress = await findHostedAddress(pkc, address);
    if (!hostedAddress) throw new Error(`${address} is not hosted by the node${where}. Hosted communities: ${pkc.communities.join(", ") || "none"}`);

    const community = await pkc.createCommunity({ address: hostedAddress });
    const settings = community.settings;
    if (!settings) throw new Error(`could not read the settings of ${address}; is the node${where} the one that runs it?`);
    const current = (settings.challenges ?? []) as ChallengeWithExclude[];

    const lines: string[] = [];
    if (current.length === 0 && !uninstall) lines.push(`${address} has no challenges, so ${botName} can already publish.`);

    let change;
    if (uninstall) change = removeBotExclude(current, botName);
    else {
        const toDecide = options.askAll || options.exemptAll ? current.map((_, index) => index) : undecidedChallenges(current, botName);
        const decisions = new Map<number, boolean>();
        for (const index of toDecide) decisions.set(index, options.exemptAll ? true : await options.decide!(current[index], index));
        change = setBotDecisions(current, botName, decisions);
    }
    const state = (challenge: ChallengeWithExclude) =>
        challengeExemptsBot(challenge, botName) ? "exempts the bot" : challengeChecksBot(challenge, botName) ? "checks the bot's replies" : "has no exclude for the bot";
    for (const index of change.changed)
        lines.push(`  challenge #${index} (${describeChallenge(current[index])}): ${uninstall ? `removed the exclude for ${botName}` : `now ${state(change.challenges[index])}`}`);
    for (const index of change.unchanged) lines.push(`  challenge #${index} (${describeChallenge(current[index])}): ${uninstall ? "had no exclude for the bot" : `already ${state(current[index])}`}`);

    // The bot badge. pkc-js replaces features and flairs as a whole on edit, so the other entries are written back.
    const offeredFlair = pickBotFlair(community);
    const listedFlairs = community.flairs?.author ?? [];
    let flairEdit: { features: Record<string, unknown>; flairs: Record<string, unknown> } | undefined;
    if (!uninstall && offeredFlair) lines.push(`  bot flair: ${botName}'s replies show "${offeredFlair.text}"`);
    else if (!uninstall) {
        const plan: BotFlairPlan = { enablesAuthorFlairs: community.features?.authorFlairs !== true, existingAuthorFlairs: listedFlairs.map((flair) => flair.text) };
        const add = options.botFlair ?? (options.decideBotFlair ? await options.decideBotFlair(plan) : false);
        if (add) {
            flairEdit = {
                features: { ...community.features, authorFlairs: true },
                // a bot flair may already be listed while the feature is off; reuse it instead of adding a second one
                flairs: { ...community.flairs, author: listedFlairs.some(isBotFlair) ? listedFlairs : [...listedFlairs, BOT_FLAIR] }
            };
            lines.push(`  bot flair: ${plan.enablesAuthorFlairs ? "turned on features.authorFlairs, " : ""}${botName}'s replies will show "${(flairEdit.flairs.author as { text: string }[]).find(isBotFlair)!.text}"`);
        } else lines.push(`  bot flair: none, so ${botName}'s replies show no bot badge (run again with --bot-flair to add one)`);
    }

    let saved = false;
    if (change.changed.length === 0 && !flairEdit) lines.push("No changes needed.");
    else if (dryRun) {
        if (change.changed.length > 0) lines.push("", "--dry-run: new settings.challenges would be:", JSON.stringify(change.challenges, null, 2));
        if (flairEdit) lines.push("", "--dry-run: new features and flairs would be:", JSON.stringify(flairEdit, null, 2));
    } else {
        await community.edit({ ...(change.changed.length > 0 ? { settings: { ...settings, challenges: change.challenges } } : {}), ...flairEdit });
        saved = true;
        lines.push("", `Saved settings of ${address}.`);
    }

    const checking = change.challenges.flatMap((challenge, index) => (challengeChecksBot(challenge, botName) ? [`#${index} (${describeChallenge(challenge)})`] : []));
    if (!uninstall && checking.length > 0)
        lines.push(
            "",
            `${botName}'s replies still go through: ${checking.join(", ")}. If one of them asks a question (a captcha, a quiz...), ` +
                "the bot cannot answer it and will not reply here; run the install script again with --ask-all to exempt it."
        );

    if (!uninstall && !dryRun)
        lines.push(
            "",
            `Privacy: when someone mentions ${botName} in your community, the thread it reads (posts, replies, their authors' ` +
                "names and addresses, images) is sent to the AI provider the bot's operator uses. Let your users know."
        );

    if (!uninstall && !dryRun && undecidedChallenges(change.challenges, botName).length === 0)
        lines.push(
            "",
            `Next step: once the community has published this update, make a post in the registry community${options.registryAddress ? ` (${options.registryAddress})` : ""} ` +
                `from the owner or an admin account, containing just: ${address}`
        );
    if (uninstall && saved) lines.push(`${botName} will stop answering in ${address} on its next update.`);
    if (uninstall && listedFlairs.some(isBotFlair))
        lines.push(`The bot author flair is still listed in flairs.author; remove it yourself if no other bot uses it.`);

    return { lines, changed: change.changed, addedBotFlair: Boolean(flairEdit) && saved, unchanged: change.unchanged, challenges: change.challenges, saved };
}
