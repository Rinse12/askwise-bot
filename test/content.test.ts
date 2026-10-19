import { describe, expect, it } from "vitest";
import { contentWithoutFailedImages, type ContentBlock } from "../src/llm/content.js";

const label = (n: number): ContentBlock => ({ type: "text", text: `Image ${n}` });
const image = (n: number): ContentBlock => ({ type: "image", source: { type: "url", url: `https://i.example/${n}.png` } });
const thread: ContentBlock = { type: "text", text: "thread" };
const urls = (blocks: ContentBlock[]) => blocks.flatMap((b) => (b.type === "image" && b.source.type === "url" ? [b.source.url] : []));

describe("contentWithoutFailedImages", () => {
    it("has nothing to retry without images", () => {
        expect(contentWithoutFailedImages([thread])).toEqual([]);
    });

    it("drops one image at a time, then all of them", () => {
        const attempts = contentWithoutFailedImages([label(1), image(1), label(2), image(2), thread]);
        expect(attempts.map(urls)).toEqual([["https://i.example/2.png"], ["https://i.example/1.png"], []]);
        expect(attempts[0][0]).toEqual({ type: "text", text: "Image 1 (could not be loaded)" });
        expect(attempts[2].at(-1)).toEqual(thread);
    });

    it("with a single image goes straight to dropping it", () => {
        const attempts = contentWithoutFailedImages([label(1), image(1), thread]);
        expect(attempts).toEqual([[{ type: "text", text: "Image 1 (could not be loaded)" }, thread]]);
    });
});
