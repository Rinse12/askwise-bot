import { addBotExclude, challengesMissingBotExclude, removeBotExclude, type ChallengeWithExclude } from "./exclude.js";

// The slice of a pkc instance the install needs, so it can be tested without a node
export interface InstallPkc {
    communities: string[];
    createCommunity(options: { address: string }): Promise<InstallCommunity>;
    getCommunity(options: { address: string }): Promise<{ address?: string; name?: string; publicKey?: string }>;
}

export interface InstallCommunity {
    settings?: { challenges?: unknown[]; [key: string]: unknown };
    edit(options: { settings: Record<string, unknown> }): Promise<unknown>;
}

export interface InstallOptions {
    address: string;
    botName: string;
    uninstall?: boolean;
    dryRun?: boolean;
    rpcLabel?: string;
    registryAddress?: string;
}

export interface InstallReport {
    lines: string[];
    changed: number[];
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

// Exempts (or with uninstall, un-exempts) the bot's name in every challenge of a community hosted by this
// node. Only challenges that need it are touched, every other setting is written back as it was, and
// nothing is saved when nothing changes or on a dry run.
export async function runInstall(pkc: InstallPkc, options: InstallOptions): Promise<InstallReport> {
    const { address, botName, uninstall = false, dryRun = false } = options;
    const where = options.rpcLabel ? ` at ${options.rpcLabel}` : "";
    const hostedAddress = await findHostedAddress(pkc, address);
    if (!hostedAddress) throw new Error(`${address} is not hosted by the node${where}. Hosted communities: ${pkc.communities.join(", ") || "none"}`);

    const community = await pkc.createCommunity({ address: hostedAddress });
    const settings = community.settings;
    if (!settings) throw new Error(`could not read the settings of ${address}; is the node${where} the one that runs it?`);
    const current = (settings.challenges ?? []) as ChallengeWithExclude[];

    const lines: string[] = [];
    if (current.length === 0 && !uninstall) lines.push(`${address} has no challenges, so ${botName} can already publish. Nothing to change.`);

    const change = uninstall ? removeBotExclude(current, botName) : addBotExclude(current, botName);
    const describe = (challenge: ChallengeWithExclude) => String(challenge.name ?? challenge.path ?? "unnamed");
    for (const index of change.changed) lines.push(`  challenge #${index} (${describe(current[index])}): ${uninstall ? "removed" : "added"} exclude for ${botName}`);
    for (const index of change.unchanged)
        lines.push(`  challenge #${index} (${describe(current[index])}): ${uninstall ? "had no exclude for the bot" : "already excludes the bot"}`);

    let saved = false;
    if (change.changed.length === 0) lines.push("No changes needed.");
    else if (dryRun) lines.push("", "--dry-run: new settings.challenges would be:", JSON.stringify(change.challenges, null, 2));
    else {
        await community.edit({ settings: { ...settings, challenges: change.challenges } });
        saved = true;
        lines.push("", `Saved settings of ${address}.`);
    }

    if (!uninstall && !dryRun && challengesMissingBotExclude(change.challenges, botName).length === 0)
        lines.push(
            "",
            `Next step: once the community has published this update, make a post in the registry community${options.registryAddress ? ` (${options.registryAddress})` : ""} ` +
                `from the owner or an admin account, containing just: ${address}`
        );
    if (uninstall && saved) lines.push(`${botName} will stop answering in ${address} on its next update.`);

    return { lines, changed: change.changed, unchanged: change.unchanged, challenges: change.challenges, saved };
}
