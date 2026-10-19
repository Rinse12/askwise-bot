import { describe, expect, it } from "vitest";
import { repliesStateOf, walkPages, type PageComment, type PageJson, type PagesJson, type RepliesState } from "../src/pages.js";

const comment = (cid: string, extra: Partial<PageComment> = {}): PageComment => ({ cid, timestamp: 1, depth: 0, ...extra });

// In-memory stand-in for the db and for IPFS page fetches
function harness(pagesByCid: Record<string, PageJson>) {
    const walked = new Set<string>();
    const states = new Map<string, RepliesState>();
    const fetched: string[] = [];
    const deps = {
        fetchPage: async (_owner: PageComment | undefined, cid: string) => {
            fetched.push(cid);
            const page = pagesByCid[cid];
            if (!page) throw new Error(`unknown page ${cid}`);
            return page;
        },
        isPageWalked: (cid: string) => walked.has(cid),
        getRepliesState: (cid: string) => states.get(cid)
    };
    const run = async (root: PagesJson) => {
        const result = await walkPages(root, deps);
        result.walkedPageCids.forEach((cid) => walked.add(cid));
        result.repliesStates.forEach((state, cid) => states.set(cid, state));
        return [...result.comments.keys()].sort();
    };
    return { run, fetched };
}

describe("walkPages", () => {
    it("works with only a preloaded hot page and no pageCids", async () => {
        const { run } = harness({});
        expect(await run({ pages: { hot: { comments: [comment("p1"), comment("p2")] } } })).toEqual(["p1", "p2"]);
    });

    it("follows a topAll pageCids chain through nextCid", async () => {
        const { run, fetched } = harness({
            page1: { comments: [comment("p1")], nextCid: "page2" },
            page2: { comments: [comment("p2")], nextCid: "page3" },
            page3: { comments: [comment("p3")] }
        });
        expect(await run({ pageCids: { topAll: "page1" } })).toEqual(["p1", "p2", "p3"]);
        expect(fetched).toEqual(["page1", "page2", "page3"]);
    });

    it("handles custom sort names and dedupes posts listed under several sorts", async () => {
        const { run } = harness({ c1: { comments: [comment("p2"), comment("p3")] } });
        expect(await run({ pages: { hot: { comments: [comment("p1"), comment("p2")] } }, pageCids: { myCustomSort: "c1", active: "c1" } })).toEqual(["p1", "p2", "p3"]);
    });

    it("recurses into nested (non-flat) replies and reply pageCids", async () => {
        const { run } = harness({
            r2page: { comments: [comment("r2", { depth: 1, parentCid: "p1" })] }
        });
        const nested = comment("r1", {
            depth: 1,
            replyCount: 1,
            replies: { pages: { best: { comments: [comment("r1a", { depth: 2, parentCid: "r1" })] } } }
        });
        const post = comment("p1", { replyCount: 3, replies: { pages: { best: { comments: [nested] } }, pageCids: { old: "r2page" } } });
        expect(await run({ pages: { hot: { comments: [post] } } })).toEqual(["p1", "r1", "r1a", "r2"]);
    });

    it("skips already walked page chains and posts whose replies did not change", async () => {
        const { run, fetched } = harness({
            postsPage: { comments: [comment("p1", { replyCount: 1, lastChildCid: "r1", replies: { pageCids: { new: "repliesPage" } } })] },
            repliesPage: { comments: [comment("r1", { depth: 1 })] }
        });
        const root = { pageCids: { new: "postsPage" } };
        expect(await run(root)).toEqual(["p1", "r1"]);
        expect(await run(root)).toEqual([]);
        expect(fetched).toEqual(["postsPage", "repliesPage"]);

        // A new preloaded snapshot of the same post with an unchanged reply state is not walked again
        const sameState = comment("p1", { replyCount: 1, lastChildCid: "r1", replies: { pageCids: { new: "repliesPage" } } });
        expect(repliesStateOf(sameState)).toEqual({ replyCount: 1, lastReplyTimestamp: null, lastChildCid: "r1" });
        expect(await run({ pages: { hot: { comments: [sameState] } } })).toEqual(["p1"]);
        expect(fetched).toEqual(["postsPage", "repliesPage"]);
    });

    it("walks a post's replies again when its reply state changed", async () => {
        const { run } = harness({});
        const v1 = comment("p1", { replyCount: 1, replies: { pages: { best: { comments: [comment("r1", { depth: 1 })] } } } });
        const v2 = comment("p1", { replyCount: 2, replies: { pages: { best: { comments: [comment("r1", { depth: 1 }), comment("r2", { depth: 1 })] } } } });
        await run({ pages: { hot: { comments: [v1] } } });
        expect(await run({ pages: { hot: { comments: [v2] } } })).toEqual(["p1", "r1", "r2"]);
    });
});
