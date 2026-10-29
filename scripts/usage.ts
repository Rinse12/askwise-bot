// Token and cost report from data/bot.db.
//
//   npm run usage -- [--since 7d] [--by community|author|model]
import { parseArgs } from "node:util";
import { dbPath, loadConfig } from "../src/config.js";
import { BotDb, type UsageGroup } from "../src/db.js";
import { parseSince } from "../src/since.js";

const { values } = parseArgs({
    options: {
        since: { type: "string", default: "7d" },
        by: { type: "string", default: "community" }
    }
});

const group = values.by as UsageGroup;
if (!["community", "author", "model"].includes(group)) throw new Error("--by must be community, author or model");

const db = new BotDb(dbPath(loadConfig().dataDir));
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
