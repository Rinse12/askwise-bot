import Database from "better-sqlite3";
import type { RepliesState } from "./pages.js";

export type CommunityStatus = "installed" | "uninstalled" | "needs_reinstall";

export interface CommunityRow {
    address: string;
    status: CommunityStatus;
    installed_at: number;
    installed_by: string;
    registry_post_cid: string | null;
    last_checked: number | null;
    status_reason: string | null;
}

export type MentionStatus = "replying" | "replied" | "rate_limited" | "skipped" | "failed";

export interface LlmUsageInput {
    community: string;
    mentionCid: string;
    author: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
}

export type UsageGroup = "community" | "author" | "model";

export interface UsageTotal {
    key: string;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
}

const now = () => Math.floor(Date.now() / 1000);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS communities (
    address TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    installed_at INTEGER NOT NULL,
    installed_by TEXT NOT NULL,
    registry_post_cid TEXT,
    last_checked INTEGER,
    status_reason TEXT
);
CREATE TABLE IF NOT EXISTS seen_comments (
    cid TEXT PRIMARY KEY,
    community TEXT NOT NULL,
    post_cid TEXT,
    seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS replies_state (
    comment_cid TEXT PRIMARY KEY,
    reply_count INTEGER,
    last_reply_timestamp INTEGER,
    last_child_cid TEXT
);
CREATE TABLE IF NOT EXISTS walked_pages (
    page_cid TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS handled_mentions (
    cid TEXT PRIMARY KEY,
    community TEXT NOT NULL,
    author TEXT NOT NULL,
    handled_at INTEGER NOT NULL,
    reply_cid TEXT,
    status TEXT NOT NULL,
    reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    comment_json TEXT
);
CREATE INDEX IF NOT EXISTS handled_mentions_community_time ON handled_mentions (community, handled_at);
CREATE INDEX IF NOT EXISTS handled_mentions_author_time ON handled_mentions (author, handled_at);
CREATE TABLE IF NOT EXISTS bot_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS llm_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    community TEXT NOT NULL,
    mention_cid TEXT NOT NULL,
    author TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS llm_usage_ts ON llm_usage (ts);
`;

export class BotDb {
    readonly db: Database.Database;

    constructor(filename: string) {
        this.db = new Database(filename);
        this.db.pragma("journal_mode = WAL");
        this.db.exec(SCHEMA);
    }

    close() {
        this.db.close();
    }

    // communities

    getCommunity(address: string): CommunityRow | undefined {
        return this.db.prepare("SELECT * FROM communities WHERE address = ?").get(address) as CommunityRow | undefined;
    }

    listCommunities(status?: CommunityStatus): CommunityRow[] {
        return (
            status
                ? this.db.prepare("SELECT * FROM communities WHERE status = ?").all(status)
                : this.db.prepare("SELECT * FROM communities").all()
        ) as CommunityRow[];
    }

    installCommunity(address: string, installedBy: string, registryPostCid: string | null) {
        const existing = this.getCommunity(address);
        if (existing) {
            // Keep the original installed_at so mentions from an uninstalled period are not answered retroactively
            const installedAt = existing.status === "installed" ? existing.installed_at : now();
            this.db
                .prepare(
                    "UPDATE communities SET status = 'installed', installed_at = ?, installed_by = ?, registry_post_cid = ?, last_checked = ?, status_reason = NULL WHERE address = ?"
                )
                .run(installedAt, installedBy, registryPostCid, now(), address);
        } else {
            this.db
                .prepare(
                    "INSERT INTO communities (address, status, installed_at, installed_by, registry_post_cid, last_checked) VALUES (?, 'installed', ?, ?, ?, ?)"
                )
                .run(address, now(), installedBy, registryPostCid, now());
        }
    }

    setCommunityStatus(address: string, status: CommunityStatus, reason: string | null) {
        this.db
            .prepare("UPDATE communities SET status = ?, status_reason = ?, last_checked = ? WHERE address = ?")
            .run(status, reason, now(), address);
    }

    // walk state

    isSeen(cid: string): boolean {
        return this.db.prepare("SELECT 1 FROM seen_comments WHERE cid = ?").get(cid) !== undefined;
    }

    isPageWalked(cid: string): boolean {
        return this.db.prepare("SELECT 1 FROM walked_pages WHERE page_cid = ?").get(cid) !== undefined;
    }

    getRepliesState(commentCid: string): RepliesState | undefined {
        const row = this.db
            .prepare("SELECT reply_count, last_reply_timestamp, last_child_cid FROM replies_state WHERE comment_cid = ?")
            .get(commentCid) as { reply_count: number | null; last_reply_timestamp: number | null; last_child_cid: string | null } | undefined;
        return row && { replyCount: row.reply_count, lastReplyTimestamp: row.last_reply_timestamp, lastChildCid: row.last_child_cid };
    }

    commitWalk(community: string, seen: { cid: string; postCid?: string }[], walkedPageCids: string[], repliesStates: Map<string, RepliesState>) {
        const markSeen = this.db.prepare("INSERT OR IGNORE INTO seen_comments (cid, community, post_cid, seen_at) VALUES (?, ?, ?, ?)");
        const markPage = this.db.prepare("INSERT OR IGNORE INTO walked_pages (page_cid) VALUES (?)");
        const setState = this.db.prepare(
            "INSERT OR REPLACE INTO replies_state (comment_cid, reply_count, last_reply_timestamp, last_child_cid) VALUES (?, ?, ?, ?)"
        );
        this.db.transaction(() => {
            const ts = now();
            for (const comment of seen) markSeen.run(comment.cid, community, comment.postCid ?? null, ts);
            for (const cid of walkedPageCids) markPage.run(cid);
            for (const [cid, state] of repliesStates) setState.run(cid, state.replyCount, state.lastReplyTimestamp, state.lastChildCid);
        })();
    }

    // mentions

    getMention(cid: string): { status: MentionStatus; reply_cid: string | null; attempts: number } | undefined {
        return this.db.prepare("SELECT status, reply_cid, attempts FROM handled_mentions WHERE cid = ?").get(cid) as
            | { status: MentionStatus; reply_cid: string | null; attempts: number }
            | undefined;
    }

    // `comment` is kept so the mention can be retried after its comment was marked seen; `retryAt` schedules
    // that retry (omitted: never retried). Every "failed" counts as an attempt.
    setMention(
        cid: string,
        community: string,
        author: string,
        status: MentionStatus,
        details: { replyCid?: string; reason?: string; retryAt?: number; comment?: unknown } = {}
    ) {
        this.db
            .prepare(
                `INSERT INTO handled_mentions (cid, community, author, handled_at, reply_cid, status, reason, attempts, next_attempt_at, comment_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(cid) DO UPDATE SET status = excluded.status, reply_cid = excluded.reply_cid, reason = excluded.reason,
                    attempts = attempts + excluded.attempts, next_attempt_at = excluded.next_attempt_at,
                    comment_json = COALESCE(excluded.comment_json, comment_json)`
            )
            .run(
                cid,
                community,
                author,
                now(),
                details.replyCid ?? null,
                status,
                details.reason ?? null,
                status === "failed" ? 1 : 0,
                details.retryAt ?? null,
                details.comment === undefined ? null : JSON.stringify(details.comment)
            );
    }

    // The bot's own replies, by CID. Needed where a community pseudonymizes authors: there the bot's comments
    // carry an alias instead of its name and key.
    isBotReply(cid: string): boolean {
        return this.db.prepare("SELECT 1 FROM handled_mentions WHERE reply_cid = ?").get(cid) !== undefined;
    }

    // Mentions of a community whose retry is due, oldest first
    dueRetries(community: string, nowTs = now()): { cid: string; comment: unknown }[] {
        const rows = this.db
            .prepare(
                `SELECT cid, comment_json FROM handled_mentions
                 WHERE community = ? AND status IN ('rate_limited', 'failed') AND next_attempt_at IS NOT NULL AND next_attempt_at <= ? AND comment_json IS NOT NULL
                 ORDER BY handled_at`
            )
            .all(community, nowTs) as { cid: string; comment_json: string }[];
        return rows.map((row) => ({ cid: row.cid, comment: JSON.parse(row.comment_json) }));
    }

    // A mention still "replying" at startup was interrupted (crash, shutdown); retry it right away.
    // In the rare case the reply was published just before the interruption, it gets answered twice.
    retryInterruptedMentions(): number {
        return this.db.prepare("UPDATE handled_mentions SET status = 'failed', reason = 'interrupted', next_attempt_at = ? WHERE status = 'replying'").run(now()).changes;
    }

    countReplies(filter: { community?: string; author?: string }, sinceTs: number): number {
        const column = filter.community !== undefined ? "community" : "author";
        const value = filter.community ?? filter.author;
        const row = this.db
            .prepare(`SELECT COUNT(*) AS n FROM handled_mentions WHERE ${column} = ? AND handled_at >= ? AND status IN ('replying', 'replied', 'failed')`)
            .get(value, sinceTs) as { n: number };
        return row.n;
    }

    // bot state

    getState(key: string): string | undefined {
        return (this.db.prepare("SELECT value FROM bot_state WHERE key = ?").get(key) as { value: string } | undefined)?.value;
    }

    setState(key: string, value: string) {
        this.db.prepare("INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)").run(key, value);
    }

    deleteState(key: string) {
        this.db.prepare("DELETE FROM bot_state WHERE key = ?").run(key);
    }

    // llm usage

    recordUsage(usage: LlmUsageInput) {
        this.db
            .prepare(
                `INSERT INTO llm_usage (ts, community, mention_cid, author, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                now(),
                usage.community,
                usage.mentionCid,
                usage.author,
                usage.model,
                usage.inputTokens,
                usage.outputTokens,
                usage.cacheReadTokens,
                usage.cacheWriteTokens,
                usage.costUsd
            );
    }

    tokensSince(community: string, sinceTs: number): number {
        const row = this.db
            .prepare(
                "SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS n FROM llm_usage WHERE community = ? AND ts >= ?"
            )
            .get(community, sinceTs) as { n: number };
        return row.n;
    }

    costSince(sinceTs: number): number {
        const row = this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM llm_usage WHERE ts >= ?").get(sinceTs) as { usd: number };
        return row.usd;
    }

    usageTotals(group: UsageGroup, sinceTs: number): UsageTotal[] {
        return this.db
            .prepare(
                `SELECT ${group} AS key, COUNT(*) AS calls, SUM(input_tokens + cache_read_tokens + cache_write_tokens) AS input_tokens,
                        SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS cost_usd
                 FROM llm_usage WHERE ts >= ? GROUP BY ${group} ORDER BY cost_usd DESC`
            )
            .all(sinceTs) as UsageTotal[];
    }
}
