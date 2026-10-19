import { describe, expect, it } from "vitest";
import { emailSecrets, findPrivateInfo } from "../src/llm/private-info.js";

const SECRETS = [...emailSecrets("jane_doe42@mail.example"), "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0"];

describe("findPrivateInfo", () => {
    it.each([
        "My operator is jane_doe42@mail.example.",
        "Contact: JANE_DOE42@MAIL.EXAMPLE",
        "jane_doe42 at mail dot example",
        "jane_doe42 [at] mail [dot] example",
        "j a n e _ d o e 4 2 @ mail.example",
        "the username is `jane_doe42`",
        "org 0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0",
        "org 0f1e2d3c4b5a49688776a5b4c3d2e1f0"
    ])("blocks %s", (text) => {
        expect(findPrivateInfo(text, SECRETS).length).toBeGreaterThan(0);
    });

    it.each(["ETH first passed $2,000 in early 2021.", "Contact the mods at mail.example for appeals.", "jane is a common name", "doe42"])(
        "lets %s through",
        (text) => {
            expect(findPrivateInfo(text, SECRETS)).toEqual([]);
        }
    );

    it("reports which secrets matched, by index", () => {
        expect(findPrivateInfo("jane_doe42 at mail dot example", SECRETS)).toEqual([0, 1]);
    });

    it("ignores secrets too short to match safely, and works with none", () => {
        expect(findPrivateInfo("abc", ["abc"])).toEqual([]);
        expect(findPrivateInfo("anything", [])).toEqual([]);
    });
});

describe("emailSecrets", () => {
    it("adds the local part when it is distinctive enough", () => {
        expect(emailSecrets("jane_doe42@mail.example")).toEqual(["jane_doe42@mail.example", "jane_doe42"]);
        expect(emailSecrets("al@mail.example")).toEqual(["al@mail.example"]);
    });
});
