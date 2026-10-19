import { challengesMissingBotExclude, type ChallengeWithExclude } from "./install/exclude.js";
import type { PageComment } from "./pages.js";
import { CommunitySubscription, isBotComment, publishAsBot, type BotContext } from "./watcher.js";

const REGISTRATION_ROLES = new Set(["owner", "admin"]);
const GET_COMMUNITY_TIMEOUT_MS = 2 * 60_000;

// A community address is a domain (.eth / .bso) or an IPNS public key (12D3KooW...).
const ADDRESS_REGEX = /(?<![\w.-])([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:eth|bso)|12D3KooW[1-9A-HJ-NP-Za-km-z]{44})(?![\w-])/i;

export const parseRegisteredAddress = (post: Pick<PageComment, "title" | "content">): string | undefined =>
    `${post.title ?? ""}\n${post.content ?? ""}`.match(ADDRESS_REGEX)?.[1];

export type Verification = { ok: true; address: string } | { ok: false; reason: string };

// Watches the registry community. An owner or admin posts their community's address there; the bot
// checks the poster's role and the public challenge excludes, answers ✅/❌, and starts watching.
export class RegistryWatcher extends CommunitySubscription {
    constructor(
        ctx: BotContext,
        address: string,
        private onInstalled: (address: string) => Promise<void>
    ) {
        super(ctx, address);
    }

    protected async scan() {
        const { fresh, commit } = await this.walkNewComments();
        for (const post of fresh) {
            if (post.depth !== 0 || isBotComment(this.ctx, post)) continue;
            await this.handleRegistration(post);
        }
        commit();
    }

    private async handleRegistration(post: PageComment) {
        const { db } = this.ctx;
        if (db.getMention(post.cid)) return;
        const poster = post.author?.address ?? "unknown";
        const verification = await this.verify(post);
        let answer: string;
        if (verification.ok) {
            db.installCommunity(verification.address, poster, post.cid);
            await this.onInstalled(verification.address);
            answer = `✅ ${this.ctx.config.botName} is installed in ${verification.address}. Mention @${this.ctx.config.botName.split(".")[0]} in a post or reply there to call it.`;
        } else answer = `❌ Not installed: ${verification.reason}`;
        console.log(`[registry] ${post.cid} by ${poster}: ${answer}`);

        try {
            const replyCid = await publishAsBot(this.ctx, this.community!, { communityAddress: this.address, parentCid: post.cid, postCid: post.cid }, answer);
            db.setMention(post.cid, this.address, poster, "replied", { replyCid, reason: verification.ok ? undefined : verification.reason });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.error(`[registry] could not answer ${post.cid}: ${reason}`);
            db.setMention(post.cid, this.address, poster, "failed", { reason });
        }
    }

    private async verify(post: PageComment): Promise<Verification> {
        const address = parseRegisteredAddress(post);
        if (!address) return { ok: false, reason: "the post does not contain a community address (a .eth/.bso name or a 12D3KooW... key)" };

        let target;
        try {
            target = await this.ctx.pkc.getCommunity({ address, abortSignal: AbortSignal.timeout(GET_COMMUNITY_TIMEOUT_MS) });
        } catch (error) {
            return { ok: false, reason: `could not load ${address}: ${error instanceof Error ? error.message : String(error)}` };
        }

        // Roles are keyed by author address (name or public key); check both forms the poster may be listed under
        const roles = (target.roles ?? {}) as Record<string, { role?: string } | undefined>;
        const posterKeys = [post.author?.address, post.author?.name, post.author?.publicKey].filter((key): key is string => Boolean(key));
        const role = posterKeys.map((key) => roles[key]?.role).find((r) => r !== undefined);
        if (!role || !REGISTRATION_ROLES.has(role))
            return { ok: false, reason: `the poster (${post.author?.address ?? "unknown"}) is not an owner or admin of ${address}` };

        const missing = challengesMissingBotExclude(target.challenges as ChallengeWithExclude[] | undefined, this.ctx.config.botName);
        if (missing.length > 0)
            return {
                ok: false,
                reason: `challenge(s) ${missing.map((i) => `#${i}`).join(", ")} of ${address} do not exclude ${this.ctx.config.botName}. Run the install script, wait for the community to publish its update, then post again.`
            };
        return { ok: true, address: target.address };
    }
}
