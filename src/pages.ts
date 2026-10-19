// Sort-agnostic walker over pkc-js pages (community.posts and comment.replies).
//
// A community may publish any subset of sorts (custom names included), `pageCids` is optional,
// timeframe sorts only hold some posts, and a reply sort may be flat or nested. So nothing here
// assumes a sort name, an order or flatness: every preloaded page and every pageCids chain is
// walked, nested replies are always followed, and comments are deduped by CID.
//
// Two things keep repeat walks cheap:
// - Page CIDs are immutable. A chain whose page was fully walked before is skipped.
// - A comment's replies are only walked again when its sort-independent reply fields changed.
// Both are returned as pending state; the caller commits them after it handled the comments,
// so a crash in between re-walks instead of losing mentions.

export interface PageAuthor {
    address?: string;
    name?: string;
    displayName?: string;
    publicKey?: string;
    flairs?: { text: string }[];
}

export interface PageComment {
    cid: string;
    postCid?: string;
    parentCid?: string;
    depth?: number;
    title?: string;
    content?: string;
    timestamp: number;
    replyCount?: number;
    lastReplyTimestamp?: number;
    lastChildCid?: string;
    author?: PageAuthor;
    signature?: { publicKey?: string };
    replies?: PagesJson;
    [key: string]: unknown;
}

export interface PageJson {
    comments: PageComment[];
    nextCid?: string;
}

export interface PagesJson {
    pages?: Record<string, PageJson | undefined>;
    pageCids?: Record<string, string | undefined>;
}

export interface RepliesState {
    replyCount: number | null;
    lastReplyTimestamp: number | null;
    lastChildCid: string | null;
}

export interface WalkDeps {
    // owner is undefined for the community's posts, otherwise the comment whose replies these are
    fetchPage(owner: PageComment | undefined, cid: string): Promise<PageJson>;
    isPageWalked(cid: string): boolean;
    getRepliesState(commentCid: string): RepliesState | undefined;
}

export interface WalkResult {
    comments: Map<string, PageComment>;
    walkedPageCids: string[];
    repliesStates: Map<string, RepliesState>;
}

export const repliesStateOf = (comment: PageComment): RepliesState => ({
    replyCount: comment.replyCount ?? null,
    lastReplyTimestamp: comment.lastReplyTimestamp ?? null,
    lastChildCid: comment.lastChildCid ?? null
});

const sameRepliesState = (a: RepliesState, b: RepliesState) =>
    a.replyCount === b.replyCount && a.lastReplyTimestamp === b.lastReplyTimestamp && a.lastChildCid === b.lastChildCid;

export async function walkPages(root: PagesJson, deps: WalkDeps): Promise<WalkResult> {
    const comments = new Map<string, PageComment>();
    const walkedPageCids: string[] = [];
    const repliesStates = new Map<string, RepliesState>();
    const visitedPageCids = new Set<string>();

    const repliesChanged = (comment: PageComment) => {
        if (repliesStates.has(comment.cid)) return false; // already handled during this walk
        const stored = deps.getRepliesState(comment.cid);
        return !stored || !sameRepliesState(stored, repliesStateOf(comment));
    };

    const handlePage = async (page: PageJson) => {
        for (const comment of page.comments) {
            if (!comments.has(comment.cid)) comments.set(comment.cid, comment);
            if (!repliesChanged(comment)) continue;
            if (comment.replies) await walk(comment.replies, comment);
            repliesStates.set(comment.cid, repliesStateOf(comment));
        }
    };

    const walkChain = async (startCid: string | undefined, owner: PageComment | undefined) => {
        const chain: string[] = [];
        let cid = startCid;
        // Pages link forward only, so a walked page means the rest of its chain was walked too
        while (cid && !visitedPageCids.has(cid) && !deps.isPageWalked(cid)) {
            visitedPageCids.add(cid);
            const page = await deps.fetchPage(owner, cid);
            await handlePage(page);
            chain.push(cid);
            cid = page.nextCid;
        }
        walkedPageCids.push(...chain);
    };

    const walk = async (pagesJson: PagesJson, owner: PageComment | undefined) => {
        for (const page of Object.values(pagesJson.pages ?? {})) {
            if (!page) continue;
            await handlePage(page);
            await walkChain(page.nextCid, owner);
        }
        for (const cid of Object.values(pagesJson.pageCids ?? {})) await walkChain(cid, owner);
    };

    await walk(root, undefined);
    return { comments, walkedPageCids, repliesStates };
}
