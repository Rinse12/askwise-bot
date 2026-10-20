import { diagnoseInstall, type ChallengeWithExclude } from "./install/exclude.js";
import type { PageComment } from "./pages.js";
import { nextAttemptAt } from "./retry.js";
import { CommunitySubscription, isBotComment, publishAsBot, type BotContext } from "./watcher.js";

const REGISTRATION_ROLES = new Set(["owner", "admin"]);
const GET_COMMUNITY_TIMEOUT_MS = 2 * 60_000;
const REPO_URL = "https://github.com/rinse12/askwise-bot";

// A community address is a domain (.eth / .bso) or an IPNS public key (12D3KooW...).
const ADDRESS_REGEX = /(?<![\w.-])([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:eth|bso)|12D3KooW[1-9A-HJ-NP-Za-km-z]{44})(?![\w-])/i;

export const parseRegisteredAddress = (post: Pick<PageComment, "title" | "content">): string | undefined =>
    `${post.title ?? ""}\n${post.content ?? ""}`.match(ADDRESS_REGEX)?.[1];

export type Verification =
    | { ok: true; address: string; alreadyInstalled: boolean }
    | { ok: false; address?: string; problems: string[]; fix: string };

// The ❌ reply: what is wrong and what to do about it.
export const formatFailure = (botName: string, failure: Extract<Verification, { ok: false }>) =>
    [
        `❌ ${botName} is not installed${failure.address ? ` in ${failure.address}` : ""}:`,
        "",
        ...failure.problems.map((problem) => `- ${problem}`),
        "",
        `To fix it: ${failure.fix}`
    ].join("\n");

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
        const posts = fresh.filter((post) => post.depth === 0 && !isBotComment(this.ctx, post)).sort((a, b) => a.timestamp - b.timestamp);
        for (const post of posts) await this.handleRegistration(post, false);
        commit();
        for (const due of this.ctx.db.dueRetries(this.address)) await this.handleRegistration(due.comment as PageComment, true);
    }

    private async handleRegistration(post: PageComment, retry: boolean) {
        const { db } = this.ctx;
        const existing = db.getMention(post.cid);
        if (existing && !retry) return;
        const poster = post.author?.address ?? "unknown";
        const verification = await this.verify(post);
        const { botName } = this.ctx.config;
        let answer: string;
        if (verification.ok) {
            db.installCommunity(verification.address, poster, post.cid);
            await this.onInstalled(verification.address);
            answer = `✅ ${botName} is ${verification.alreadyInstalled ? "already " : ""}installed in ${verification.address}. Mention @${botName.split(".")[0]} in a post or reply there to call it.`;
        } else answer = formatFailure(botName, verification);
        console.log(`[registry] ${post.cid} by ${poster}: ${answer.split("\n").join(" ")}`);

        try {
            const replyCid = await publishAsBot(this.ctx, this.community!, { communityAddress: this.address, parentCid: post.cid, postCid: post.cid }, answer);
            db.setMention(post.cid, this.address, poster, "replied", { replyCid, reason: verification.ok ? undefined : verification.problems.join("; ") });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const attempts = (existing?.status === "failed" ? existing.attempts : 0) + 1;
            const { replies: _replies, ...comment } = post;
            const retryAt = nextAttemptAt({ kind: "failed", attempts, retryable: true }, post.timestamp, this.ctx.config.limits, Math.floor(Date.now() / 1000));
            console.error(`[registry] could not answer ${post.cid} (attempt ${attempts}${retryAt ? ", will retry" : ", giving up"}): ${reason}`);
            db.setMention(post.cid, this.address, poster, "failed", { reason, retryAt, comment });
        }
    }

    private async verify(post: PageComment): Promise<Verification> {
        const { botName } = this.ctx.config;
        const address = parseRegisteredAddress(post);
        if (!address)
            return {
                ok: false,
                problems: ["the post does not contain a community address (a .bso name or a 12D3KooW... key)"],
                fix: "post again with just your community's address, e.g. `mycommunity.bso`."
            };

        let target;
        try {
            target = await this.ctx.pkc.getCommunity({ address, abortSignal: AbortSignal.timeout(GET_COMMUNITY_TIMEOUT_MS) });
        } catch (error) {
            return {
                ok: false,
                address,
                problems: [`the community could not be loaded (${error instanceof Error ? error.message : String(error)})`],
                fix: "check the address, make sure the node running the community is online, then post again."
            };
        }

        // Roles are keyed by author address (name or public key); check both forms the poster may be listed under
        const roles = (target.roles ?? {}) as Record<string, { role?: string } | undefined>;
        const posterKeys = [post.author?.address, post.author?.name, post.author?.publicKey].filter((key): key is string => Boolean(key));
        const role = posterKeys.map((key) => roles[key]?.role).find((r) => r !== undefined);
        if (!role || !REGISTRATION_ROLES.has(role))
            return {
                ok: false,
                address,
                problems: [`the poster (${post.author?.address ?? "unknown"}) is ${role ? `only a ${role}` : "not an owner or admin"} of the community`],
                fix: "post again from the owner's account or an admin's account."
            };

        const { installed, problems } = diagnoseInstall(target.challenges as ChallengeWithExclude[] | undefined, botName);
        if (!installed)
            return {
                ok: false,
                address,
                problems,
                fix:
                    `on the machine running the community's bitsocial-cli, run \`npm run install-bot -- --community ${address}\` from ${REPO_URL}. ` +
                    "It exempts the bot from every challenge and leaves your users' challenges as they are. Wait for the community to publish its update (about a minute), then post here again."
            };
        return { ok: true, address: target.address, alreadyInstalled: this.ctx.db.getCommunity(target.address)?.status === "installed" };
    }
}
