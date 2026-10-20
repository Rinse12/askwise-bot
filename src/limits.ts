import type { Limits } from "./config.js";
import type { BotDb } from "./db.js";

// scope: whose limit was hit, the author's own or one shared by the community (community and global limits)
export type LimitVerdict = { ok: true } | { ok: false; reason: string; scope: "author" | "community" };

const HOUR = 3600;
const DAY = 24 * HOUR;

// Checked before the LLM is called, so a blocked mention costs nothing.
export function checkLimits(db: BotDb, limits: Limits, mention: { community: string; author: string }, nowTs = Math.floor(Date.now() / 1000)): LimitVerdict {
    if (db.costSince(nowTs - DAY) >= limits.globalUsdPerDay) return { ok: false, reason: `global daily spend cap of $${limits.globalUsdPerDay} reached`, scope: "community" };
    if (db.countReplies({ community: mention.community }, nowTs - HOUR) >= limits.communityRepliesPerHour)
        return { ok: false, reason: `community hourly reply limit of ${limits.communityRepliesPerHour} reached`, scope: "community" };
    if (db.tokensSince(mention.community, nowTs - DAY) >= limits.communityTokensPerDay)
        return { ok: false, reason: `community daily token budget of ${limits.communityTokensPerDay} reached`, scope: "community" };
    if (db.countReplies({ author: mention.author }, nowTs - HOUR) >= limits.authorMentionsPerHour)
        return { ok: false, reason: `author hourly mention limit of ${limits.authorMentionsPerHour} reached`, scope: "author" };
    return { ok: true };
}

export const LIMIT_NOTICE = "I've reached my reply limit for now, so I can't answer this yet. I'll reply here once it resets.";

// A rate-limited mention gets the notice, but at most once an hour per author (for their own limit) or per
// community (for shared limits), so mentioning the bot repeatedly can't turn the notices into spam.
export function limitNoticeDue(db: BotDb, verdict: Extract<LimitVerdict, { ok: false }>, mention: { community: string; author: string }, nowTs: number): boolean {
    const key = verdict.scope === "author" ? `limit-notice:${mention.community}:${mention.author}` : `limit-notice:${mention.community}`;
    const last = db.getState(key);
    if (last !== undefined && nowTs - Number(last) < HOUR) return false;
    db.setState(key, String(nowTs));
    return true;
}
