import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { BotDb } from "./db.js";

// Mirrors pkc-js AuthorPubsubSchema (strict), which the package does not export.
export type BotAuthor = {
    name: string;
    displayName?: string;
    previousCommentCid?: string;
    flairs?: { text: string; backgroundColor?: string; textColor?: string }[];
    avatar?: { chainTicker: string; address: string; id: string; timestamp: number; signature: { signature: string; type: string } };
    wallets?: Record<string, { address: string; timestamp: number; signature: { signature: string; type: string } }>;
};

type Flair = NonNullable<BotAuthor["flairs"]>[number];

const PROFILE_KEYS = new Set(["displayName", "avatar", "wallets"]);
export const PREVIOUS_COMMENT_CID_KEY = "previous_comment_cid";

// A community only accepts an author flair when community.features.authorFlairs is on and the flair is
// one of its community.flairs.author entries. So the bot marks itself as a bot only where the community
// offers such a flair (any author flair whose text contains "bot"), and sends that exact flair.
export function pickBotFlair(community: { features?: unknown; flairs?: unknown }): Flair | undefined {
    if ((community.features as { authorFlairs?: boolean } | undefined)?.authorFlairs !== true) return undefined;
    const authorFlairs = (community.flairs as { author?: Flair[] } | undefined)?.author ?? [];
    return authorFlairs.find((flair) => /\bbots?\b/i.test(flair.text));
}

// Optional data/author-profile.json: fields that need signatures from the wallet owning the name
// (avatar NFT, wallets) are produced offline and dropped here; it may also override displayName.
export function loadAuthorProfile(dataDir: string): Partial<BotAuthor> {
    const file = path.join(dataDir, "author-profile.json");
    if (!fs.existsSync(file)) return {};
    const profile = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const unknownKeys = Object.keys(profile).filter((key) => !PROFILE_KEYS.has(key));
    if (unknownKeys.length > 0) throw new Error(`${file} has unsupported keys: ${unknownKeys.join(", ")} (allowed: ${[...PROFILE_KEYS].join(", ")})`);
    return profile as Partial<BotAuthor>;
}

export function buildBotAuthor(config: Pick<Config, "botName" | "botDisplayName">, db: BotDb, profile: Partial<BotAuthor>, flair: Flair | undefined): BotAuthor {
    const previousCommentCid = db.getState(PREVIOUS_COMMENT_CID_KEY);
    return {
        displayName: config.botDisplayName,
        ...profile,
        ...(flair ? { flairs: [flair] } : {}),
        // the challenge exclude matches on this name, so the profile can never override it
        name: config.botName,
        ...(previousCommentCid ? { previousCommentCid } : {})
    };
}
