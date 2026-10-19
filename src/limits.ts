import type { Limits } from "./config.js";
import type { BotDb } from "./db.js";

export type LimitVerdict = { ok: true } | { ok: false; reason: string };

const HOUR = 3600;
const DAY = 24 * HOUR;

// Checked before the LLM is called, so a blocked mention costs nothing.
export function checkLimits(db: BotDb, limits: Limits, mention: { community: string; author: string }, nowTs = Math.floor(Date.now() / 1000)): LimitVerdict {
    if (db.costSince(nowTs - DAY) >= limits.globalUsdPerDay) return { ok: false, reason: `global daily spend cap of $${limits.globalUsdPerDay} reached` };
    if (db.countReplies({ community: mention.community }, nowTs - HOUR) >= limits.communityRepliesPerHour)
        return { ok: false, reason: `community hourly reply limit of ${limits.communityRepliesPerHour} reached` };
    if (db.tokensSince(mention.community, nowTs - DAY) >= limits.communityTokensPerDay)
        return { ok: false, reason: `community daily token budget of ${limits.communityTokensPerDay} reached` };
    if (db.countReplies({ author: mention.author }, nowTs - HOUR) >= limits.authorMentionsPerHour)
        return { ok: false, reason: `author hourly mention limit of ${limits.authorMentionsPerHour} reached` };
    return { ok: true };
}
