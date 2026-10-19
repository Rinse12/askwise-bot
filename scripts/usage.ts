// Token and cost report from data/bitsocialbot.db.
//
//   npm run usage -- [--since 7d] [--by community|author|model]
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { BotDb, type UsageGroup } from "../src/db.js";

const { values } = parseArgs({
    options: {
        since: { type: "string", default: "7d" },
        by: { type: "string", default: "community" }
    }
});

const UNITS: Record<string, number> = { h: 3600, d: 86400, w: 604800 };

function parseSince(since: string): number {
    if (since === "all") return 0;
    const match = since.match(/^(\d+)([hdw])$/);
    if (!match) throw new Error(`--since must look like 24h, 7d, 4w or all`);
    return Math.floor(Date.now() / 1000) - Number(match[1]) * UNITS[match[2]];
}

const group = values.by as UsageGroup;
if (!["community", "author", "model"].includes(group)) throw new Error("--by must be community, author or model");

const db = new BotDb(path.join(loadConfig().dataDir, "bitsocialbot.db"));
const rows = db.usageTotals(group, parseSince(values.since!));
db.close();

if (rows.length === 0) {
    console.log(`No LLM usage in the last ${values.since}.`);
} else {
    const total = rows.reduce(
        (sum, row) => ({ calls: sum.calls + row.calls, input: sum.input + row.input_tokens, output: sum.output + row.output_tokens, cost: sum.cost + row.cost_usd }),
        { calls: 0, input: 0, output: 0, cost: 0 }
    );
    console.table([
        ...rows.map((row) => ({ [group]: row.key, calls: row.calls, input_tokens: row.input_tokens, output_tokens: row.output_tokens, cost_usd: row.cost_usd.toFixed(4) })),
        { [group]: "TOTAL", calls: total.calls, input_tokens: total.input, output_tokens: total.output, cost_usd: total.cost.toFixed(4) }
    ]);
}
