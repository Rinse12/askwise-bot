import { buildBotAuthor, pickBotFlair, PREVIOUS_COMMENT_CID_KEY, type BotAuthor } from "./author.js";
import type { Config } from "./config.js";
import type { BotDb } from "./db.js";
import { challengesMissingBotExclude, diagnoseInstall, type ChallengeWithExclude } from "./install/exclude.js";
import { checkLimits } from "./limits.js";
import { isTooOld, nextAttemptAt } from "./retry.js";
import { LlmRefusalError, type LlmClient, type LlmReply } from "./llm/types.js";
import { extractImageUrls, type ThreadImage } from "./images.js";
import { buildThreadContext, mentionsBot } from "./mentions.js";
import { walkPages, type PageComment, type PageJson, type PagesJson, type WalkResult } from "./pages.js";
import type { BotSigner, PkcInstance, RemoteCommunity } from "./pkc.js";
import { ChallengedError, publishReply, type ReplyTarget } from "./reply.js";

const MAX_ANCESTORS = 10;

// The calling comment's images first, then the nearest ancestors', so a cap on images drops the least relevant
export function threadImages(mention: PageComment, ancestors: PageComment[]): ThreadImage[] {
    const label = (comment: PageComment) =>
        comment === mention ? (ancestors.length === 0 ? "in the post calling you" : "in the comment calling you") : comment === ancestors[0] ? "in the post" : `in the reply at depth ${comment.depth}`;
    const urls = new Map<string, string>();
    for (const comment of [mention, ...[...ancestors].reverse()]) for (const url of extractImageUrls(comment)) if (!urls.has(url)) urls.set(url, label(comment));
    return [...urls].map(([url, where]) => ({ url, label: where }));
}

export interface BotContext {
    pkc: PkcInstance;
    signer: BotSigner;
    db: BotDb;
    llm: LlmClient;
    config: Config;
    authorProfile: Partial<BotAuthor>;
    mentionRegex: RegExp;
}

// Every bot publication carries author.previousCommentCid, so publishes have to happen one at a time.
let publishQueue: Promise<unknown> = Promise.resolve();
export function publishAsBot(ctx: BotContext, community: RemoteCommunity, target: ReplyTarget, content: string): Promise<string> {
    const run = publishQueue.then(async () => {
        const author = buildBotAuthor(ctx.config, ctx.db, ctx.authorProfile, pickBotFlair(community));
        const cid = await publishReply(ctx.pkc, ctx.signer, author, target, content);
        ctx.db.setState(PREVIOUS_COMMENT_CID_KEY, cid);
        return cid;
    });
    publishQueue = run.catch(() => {});
    return run;
}

export const isBotComment = (ctx: BotContext, comment: Pick<PageComment, "cid" | "author">) =>
    comment.author?.address === ctx.signer.address || comment.author?.name?.toLowerCase() === ctx.config.botName || ctx.db.isBotReply(comment.cid);

// Base for anything that follows one community: subscribes to updates and runs at most one scan at a
// time, coalescing updates that arrive during a scan into one follow-up scan.
export abstract class CommunitySubscription {
    protected community?: RemoteCommunity;
    private scanning = false;
    private rescan = false;
    private stopped = false;
    private rescanTimer?: NodeJS.Timeout;

    get isStopped() {
        return this.stopped;
    }

    constructor(
        protected ctx: BotContext,
        readonly address: string
    ) {}

    async start() {
        this.community = await this.ctx.pkc.getCommunity({ address: this.address });
        this.community.on("update", () => this.scheduleScan());
        this.community.on("error", (error: unknown) => console.error(`[${this.address}] community error:`, error));
        await this.community.update();
        this.scheduleScan();
        // Also rescan on a timer: due retries must run even when the community publishes no update
        this.rescanTimer = setInterval(() => this.scheduleScan(), this.ctx.config.limits.rescanIntervalSeconds * 1000);
    }

    async stop() {
        this.stopped = true;
        clearInterval(this.rescanTimer);
        await this.community?.stop();
    }

    private scheduleScan() {
        if (this.stopped) return;
        if (this.scanning) {
            this.rescan = true;
            return;
        }
        this.scanning = true;
        void (async () => {
            do {
                this.rescan = false;
                try {
                    await this.scan();
                } catch (error) {
                    console.error(`[${this.address}] scan failed:`, error);
                }
            } while (this.rescan && !this.stopped);
            this.scanning = false;
        })();
    }

    protected abstract scan(): Promise<void>;

    // Walks every sort the community published; see pages.ts. Returns the comments not seen before
    // and a commit function to call once they have been handled.
    protected async walkNewComments(): Promise<{ fresh: PageComment[]; all: WalkResult["comments"]; commit: () => void }> {
        const community = this.community!;
        const { pkc, db } = this.ctx;
        const result = await walkPages(community.posts as unknown as PagesJson, {
            fetchPage: async (owner, cid) => {
                if (!owner) return (await community.posts.getPage({ cid })) as unknown as PageJson;
                const comment = await pkc.createComment(owner as unknown as Parameters<PkcInstance["createComment"]>[0]);
                return (await comment.replies.getPage({ cid })) as unknown as PageJson;
            },
            isPageWalked: (cid) => db.isPageWalked(cid),
            getRepliesState: (cid) => db.getRepliesState(cid)
        });
        const fresh = [...result.comments.values()].filter((comment) => !db.isSeen(comment.cid));
        return {
            fresh,
            all: result.comments,
            commit: () => db.commitWalk(this.address, fresh, result.walkedPageCids, result.repliesStates)
        };
    }
}

// What a retry needs from a mention, without the (possibly large) nested reply pages
const mentionSnapshot = ({ replies: _replies, ...comment }: PageComment): PageComment => comment;

export class CommunityWatcher extends CommunitySubscription {
    protected async scan() {
        const { db, config } = this.ctx;
        const row = db.getCommunity(this.address);
        if (!row || row.status === "uninstalled") return;

        const challenges = this.community!.challenges as ChallengeWithExclude[] | undefined;
        const missing = challengesMissingBotExclude(challenges, config.botName);
        if (missing.length > 0) {
            // None exempt the bot: the owner uninstalled it. Some do: challenges were added after installing.
            const uninstalled = missing.length === challenges!.length;
            const reason = uninstalled
                ? "no challenge excludes the bot anymore"
                : `${diagnoseInstall(challenges, config.botName).problems.join("; ")}. Run the install script again`;
            if (row.status !== (uninstalled ? "uninstalled" : "needs_reinstall") || row.status_reason !== reason) {
                console.warn(`[${this.address}] ${reason}`);
                db.setCommunityStatus(this.address, uninstalled ? "uninstalled" : "needs_reinstall", reason);
            }
            if (uninstalled) await this.stop();
            // Not walking while the install is incomplete leaves mentions unseen, so they are answered once it is fixed
            return;
        }
        if (row.status === "needs_reinstall") {
            console.log(`[${this.address}] install is complete again`);
            db.setCommunityStatus(this.address, "installed", null);
        }

        const { fresh, all, commit } = await this.walkNewComments();
        // A backlog (e.g. after the bot was offline) is answered oldest first
        const mentions = fresh
            .filter((comment) => comment.timestamp >= row.installed_at && !isBotComment(this.ctx, comment) && mentionsBot(comment, this.ctx.mentionRegex))
            .sort((a, b) => a.timestamp - b.timestamp);
        for (const mention of mentions) await this.handleMention(mention, all, false);
        commit();

        for (const due of db.dueRetries(this.address)) await this.handleMention(due.comment as PageComment, all, true);
    }

    private async loadAncestors(mention: PageComment, known: Map<string, PageComment>): Promise<PageComment[]> {
        const ancestors: PageComment[] = [];
        let parentCid = mention.parentCid;
        while (parentCid && ancestors.length < MAX_ANCESTORS) {
            const parent = known.get(parentCid) ?? ((await this.ctx.pkc.getComment({ cid: parentCid })) as unknown as PageComment);
            ancestors.unshift(parent);
            parentCid = parent.parentCid;
        }
        return ancestors;
    }

    private async handleMention(mention: PageComment, known: Map<string, PageComment>, retry: boolean) {
        const { db, config, llm } = this.ctx;
        const existing = db.getMention(mention.cid);
        if (existing && !retry) return;
        const author = mention.author?.address ?? "unknown";
        const comment = mentionSnapshot(mention);
        const record = (status: Parameters<BotDb["setMention"]>[3], details?: Parameters<BotDb["setMention"]>[4]) =>
            db.setMention(mention.cid, this.address, author, status, { comment, ...details });
        const nowTs = Math.floor(Date.now() / 1000);

        if (isTooOld(mention.timestamp, config.limits, nowTs)) {
            record("skipped", { reason: `older than ${config.limits.mentionMaxAgeHours}h` });
            return;
        }
        const verdict = checkLimits(db, config.limits, { community: this.address, author });
        if (!verdict.ok) {
            const retryAt = nextAttemptAt({ kind: "rate_limited" }, mention.timestamp, config.limits, nowTs);
            if (!retry) console.log(`[${this.address}] not answering ${mention.cid} yet: ${verdict.reason}`);
            record("rate_limited", { reason: verdict.reason, retryAt });
            return;
        }
        record("replying");

        try {
            const ancestors = await this.loadAncestors(mention, known);
            const botRepliesInThread = ancestors.filter((comment) => isBotComment(this.ctx, comment)).length;
            if (botRepliesInThread >= config.limits.maxBotRepliesInThread) {
                record("skipped", { reason: `bot already replied ${botRepliesInThread} times in this thread` });
                return;
            }

            let reply: LlmReply;
            try {
                reply = await llm.reply({ community: this.address, threadContext: buildThreadContext(mention, ancestors), images: threadImages(mention, ancestors) });
            } catch (error) {
                // A refusal is still billed
                const refused = error instanceof LlmRefusalError ? (error as LlmRefusalError & { reply?: LlmReply }).reply : undefined;
                if (refused) this.recordUsage(mention, author, refused);
                throw error;
            }
            this.recordUsage(mention, author, reply);
            if (!reply.text) throw new Error("LLM returned an empty reply");

            const replyCid = await publishAsBot(this.ctx, this.community!, { communityAddress: this.address, parentCid: mention.cid, postCid: mention.postCid ?? mention.cid }, reply.text);
            record("replied", { replyCid });
            console.log(`[${this.address}] replied to ${mention.cid} with ${replyCid}`);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const attempts = (existing?.status === "failed" ? existing.attempts : 0) + 1;
            // A refusal would only be refused again; anything else (network, node, LLM outage, install fixed later) may pass next time
            const retryAt = nextAttemptAt({ kind: "failed", attempts, retryable: !(error instanceof LlmRefusalError) }, mention.timestamp, config.limits, nowTs);
            console.error(`[${this.address}] failed to answer ${mention.cid} (attempt ${attempts}${retryAt ? ", will retry" : ", giving up"}): ${reason}`);
            record("failed", { reason, retryAt });
            if (error instanceof ChallengedError) db.setCommunityStatus(this.address, "needs_reinstall", reason);
        }
    }

    private recordUsage(mention: PageComment, author: string, reply: LlmReply) {
        this.ctx.db.recordUsage({
            community: this.address,
            mentionCid: mention.cid,
            author,
            model: reply.model,
            inputTokens: reply.inputTokens,
            outputTokens: reply.outputTokens,
            cacheReadTokens: reply.cacheReadTokens,
            cacheWriteTokens: reply.cacheWriteTokens,
            costUsd: reply.costUsd
        });
    }
}
