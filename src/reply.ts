import type { BotAuthor } from "./author.js";
import type { BotSigner, PkcInstance } from "./pkc.js";

export class ChallengedError extends Error {}

export interface ReplyTarget {
    communityAddress: string;
    parentCid: string;
    postCid: string;
}

const PUBLISH_TIMEOUT_MS = 5 * 60_000;

// Publishes a reply and resolves with its CID. The bot never answers challenges: an installed
// community excludes the bot's name from every challenge, so being challenged means the install
// is missing or incomplete, and is reported as ChallengedError.
export async function publishReply(pkc: PkcInstance, signer: BotSigner, author: BotAuthor, target: ReplyTarget, content: string): Promise<string> {
    const comment = await pkc.createComment({ ...target, content, signer, author });

    return new Promise<string>((resolve, reject) => {
        let settled = false;
        const finish = (error: Error | undefined, cid?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (error) {
                comment.stop().catch(() => {});
                reject(error);
            } else resolve(cid!);
        };
        const timeout = setTimeout(() => finish(new Error(`publishing reply to ${target.parentCid} timed out`)), PUBLISH_TIMEOUT_MS);

        comment.on("challenge", (challenge: { challenges?: { type?: string }[] }) => {
            const types = challenge.challenges?.map((c) => c.type).join(", ");
            finish(new ChallengedError(`${target.communityAddress} challenged the bot (${types ?? "unknown"}); its challenges do not exclude the bot's name`));
        });
        comment.on("challengeverification", (verification: { challengeSuccess: boolean; reason?: string; challengeErrors?: Record<string, string>; commentUpdate?: { cid?: string } }) => {
            if (verification.challengeSuccess) {
                const cid = verification.commentUpdate?.cid ?? comment.cid;
                if (cid) finish(undefined, cid);
                else finish(new Error("challenge verification succeeded without a comment cid"));
            } else {
                const details = verification.reason ?? JSON.stringify(verification.challengeErrors ?? {});
                finish(new Error(`publication rejected by ${target.communityAddress}: ${details}`));
            }
        });
        comment.on("error", (error: Error) => finish(error));

        comment.publish().catch((error: Error) => finish(error));
    });
}
