import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dbPath } from "../src/config.js";

describe("dbPath", () => {
    it("moves a pre-rename bitsocialbot.db and its wal/shm to bot.db once", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-path-"));
        for (const suffix of ["", "-wal"]) fs.writeFileSync(path.join(dir, `bitsocialbot.db${suffix}`), suffix || "main");
        expect(dbPath(dir)).toBe(path.join(dir, "bot.db"));
        expect(fs.readdirSync(dir).sort()).toEqual(["bot.db", "bot.db-wal"]);
        expect(fs.readFileSync(path.join(dir, "bot.db"), "utf8")).toBe("main");
    });

    it("leaves an existing bot.db alone", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-path-"));
        fs.writeFileSync(path.join(dir, "bot.db"), "new");
        fs.writeFileSync(path.join(dir, "bitsocialbot.db"), "old");
        dbPath(dir);
        expect(fs.readFileSync(path.join(dir, "bot.db"), "utf8")).toBe("new");
    });
});
