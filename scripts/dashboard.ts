// Local, read-only web dashboard over data/bot.db: communities, mentions answered, tokens and cost.
// It reads the same database as the bot, so it can run alongside it.
//
//   npm run dashboard -- [--port 8787] [--host 127.0.0.1]
//
// Then open http://127.0.0.1:8787/?since=7d (24h, 7d, 4w, all). It lists authors and mention excerpts,
// so keep it on localhost (or behind ssh -L) rather than exposing it.
import http from "node:http";
import { parseArgs } from "node:util";
import { dbPath, loadConfig } from "../src/config.js";
import { BotDb, type CommunityReport, type DailyReport, type MentionReport } from "../src/db.js";
import { parseSince } from "../src/since.js";

const { values } = parseArgs({
    options: {
        port: { type: "string", default: "8787" },
        host: { type: "string", default: "127.0.0.1" }
    }
});

const PERIODS = ["24h", "7d", "4w", "all"];
const MENTION_ROWS = 300;
const DAY = 86400;

const config = loadConfig();
const db = new BotDb(dbPath(config.dataDir));

const esc = (value: unknown) =>
    String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const int = (n: number) => Math.round(n).toLocaleString("en-US");
const usd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(2)}`);
const pct = (part: number, whole: number) => (whole === 0 ? "–" : `${Math.round((part / whole) * 100)}%`);
const time = (ts: number | null) => (ts ? new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16) : "–");
const short = (address: string) => (address.length > 20 ? `${address.slice(0, 8)}…${address.slice(-4)}` : address);
const seedit = (community: string, cid: string) => `https://seedit.app/#/s/${encodeURIComponent(community)}/comments/${cid}`;

function excerpt(row: MentionReport): { author: string; text: string } {
    if (!row.comment_json) return { author: row.author, text: "" };
    const comment = JSON.parse(row.comment_json) as { title?: string; content?: string; author?: { name?: string; address?: string } };
    const text = [comment.title, comment.content].filter(Boolean).join(" — ").replace(/\s+/g, " ");
    return { author: comment.author?.name || comment.author?.address || row.author, text: text.length > 160 ? `${text.slice(0, 160)}…` : text };
}

function tiles(communities: CommunityReport[], since: string): string {
    const sum = (key: keyof CommunityReport) => communities.reduce((total, row) => total + Number(row[key] ?? 0), 0);
    const nowTs = Math.floor(Date.now() / 1000);
    const spent24h = db.costSince(nowTs - DAY);
    const replied = sum("replied");
    const tile = (label: string, value: string, note = "") =>
        `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="note">${note}</div></div>`;
    return `<div class="tiles">
        ${tile("Communities installed", int(communities.filter((row) => row.status === "installed").length), `${int(communities.filter((row) => row.status === "needs_reinstall").length)} need reinstall`)}
        ${tile(`Mentions (${since})`, int(sum("mentions")), `${int(replied)} replied · ${int(sum("failed"))} failed · ${int(sum("rate_limited"))} rate-limited · ${int(sum("skipped"))} skipped`)}
        ${tile(`Tokens (${since})`, int(sum("input_tokens") + sum("output_tokens")), `${int(sum("input_tokens"))} in · ${int(sum("output_tokens"))} out · ${pct(sum("cache_read_tokens"), sum("input_tokens"))} cache reads`)}
        ${tile(`Cost (${since})`, usd(sum("cost_usd")), `${usd(replied ? sum("cost_usd") / replied : 0)} per reply · ${int(sum("calls"))} LLM calls`)}
        ${tile("Spend, last 24h", usd(spent24h), `${pct(spent24h, config.limits.globalUsdPerDay)} of the $${config.limits.globalUsdPerDay} daily cap`)}
    </div>`;
}

function dailyChart(days: DailyReport[]): string {
    if (days.length === 0) return "";
    const max = Math.max(...days.map((day) => day.cost_usd), 1e-9);
    const rows = days
        .map(
            (day) => `<tr><td class="nowrap">${esc(day.day)}</td>
                <td class="bar-cell"><div class="bar" style="width:${((day.cost_usd / max) * 100).toFixed(1)}%"></div></td>
                <td class="num">${usd(day.cost_usd)}</td><td class="num">${int(day.tokens)}</td><td class="num">${int(day.calls)}</td></tr>`
        )
        .join("");
    return `<h2>Per day (UTC)</h2><div class="scroll"><table><thead><tr><th>Day</th><th>Cost</th><th class="num">USD</th><th class="num">Tokens</th><th class="num">Calls</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function communityTable(communities: CommunityReport[]): string {
    const nowTs = Math.floor(Date.now() / 1000);
    const rows = communities
        .map((row) => {
            const tokens24h = db.tokensSince(row.address, nowTs - DAY);
            return `<tr>
                <td>${esc(row.address)}</td>
                <td><span class="status ${esc(row.status ?? "none")}">${esc(row.status ?? "not installed")}</span></td>
                <td class="num">${int(row.mentions)}</td><td class="num">${int(row.replied)}</td>
                <td class="num">${int(row.failed)}</td><td class="num">${int(row.rate_limited)}</td><td class="num">${int(row.skipped)}</td>
                <td class="num">${int(row.input_tokens)}</td><td class="num">${int(row.output_tokens)}</td>
                <td class="num">${usd(row.cost_usd)}</td>
                <td class="num" title="${int(tokens24h)} of ${int(config.limits.communityTokensPerDay)} tokens">${pct(tokens24h, config.limits.communityTokensPerDay)}</td>
                <td class="nowrap">${time(row.last_mention_at)}</td>
                <td class="nowrap">${time(row.installed_at)}</td>
            </tr>`;
        })
        .join("");
    return `<h2>Communities</h2><div class="scroll"><table><thead><tr>
        <th>Community</th><th>Status</th><th class="num">Mentions</th><th class="num">Replied</th><th class="num">Failed</th><th class="num">Rate-ltd</th><th class="num">Skipped</th>
        <th class="num">Tokens in</th><th class="num">Tokens out</th><th class="num">Cost</th><th class="num" title="tokens in the last 24h vs LIMIT_COMMUNITY_TOKENS_PER_DAY">Budget 24h</th>
        <th>Last mention</th><th>Installed</th>
    </tr></thead><tbody>${rows || `<tr><td colspan="13" class="empty">No communities yet.</td></tr>`}</tbody></table></div>`;
}

function mentionTable(mentions: MentionReport[]): string {
    const rows = mentions
        .map((row) => {
            const { author, text } = excerpt(row);
            return `<tr>
                <td class="nowrap">${time(row.handled_at)}</td>
                <td>${esc(row.community)}</td>
                <td title="${esc(row.author)}">${esc(short(author))}</td>
                <td class="text"><a href="${esc(seedit(row.community, row.cid))}" target="_blank" rel="noreferrer">${esc(text || row.cid)}</a></td>
                <td><span class="status ${esc(row.status)}" title="${esc(row.reason ?? "")}">${esc(row.status)}</span>${row.attempts > 1 ? ` <span class="muted">×${row.attempts}</span>` : ""}
                    ${row.reason ? `<div class="reason">${esc(row.reason)}</div>` : ""}</td>
                <td class="num">${int(row.input_tokens)}</td><td class="num">${int(row.output_tokens)}</td><td class="num">${usd(row.cost_usd)}</td>
                <td>${row.reply_cid ? `<a href="${esc(seedit(row.community, row.reply_cid))}" target="_blank" rel="noreferrer">reply</a>` : ""}</td>
            </tr>`;
        })
        .join("");
    return `<h2>Mentions${mentions.length === MENTION_ROWS ? ` (latest ${MENTION_ROWS})` : ""}</h2><div class="scroll"><table><thead><tr>
        <th>Handled</th><th>Community</th><th>Author</th><th>Mention</th><th>Status</th><th class="num">Tokens in</th><th class="num">Tokens out</th><th class="num">Cost</th><th></th>
    </tr></thead><tbody>${rows || `<tr><td colspan="9" class="empty">No mentions in this period.</td></tr>`}</tbody></table></div>`;
}

const STYLE = `
:root { --bg: #fafaf9; --panel: #ffffff; --text: #1c1917; --muted: #78716c; --line: #e7e5e4; --accent: #2563eb;
        --ok: #15803d; --warn: #b45309; --bad: #b91c1c; color-scheme: light dark; }
@media (prefers-color-scheme: dark) {
    :root { --bg: #0c0a09; --panel: #1c1917; --text: #f5f5f4; --muted: #a8a29e; --line: #292524; --accent: #60a5fa;
            --ok: #4ade80; --warn: #fbbf24; --bad: #f87171; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, sans-serif; }
main { max-width: 1280px; margin: 0 auto; }
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; justify-content: space-between; }
h1 { font-size: 20px; margin: 0; } h2 { font-size: 15px; margin: 32px 0 8px; }
.muted, .note, .label { color: var(--muted); }
nav a { margin-left: 4px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--text); text-decoration: none; }
nav a.active { background: var(--text); color: var(--bg); border-color: var(--text); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-top: 20px; }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; }
.label { font-size: 12px; } .value { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; } .note { font-size: 12px; }
.scroll { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; }
th, td { padding: 7px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { font-size: 12px; font-weight: 500; color: var(--muted); white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.nowrap { white-space: nowrap; } .text { min-width: 260px; max-width: 480px; } .empty { color: var(--muted); text-align: center; }
a { color: var(--accent); }
.reason { font-size: 12px; color: var(--muted); max-width: 260px; }
.status { font-size: 12px; font-weight: 500; white-space: nowrap; }
.status.replied, .status.installed { color: var(--ok); }
.status.rate_limited, .status.replying, .status.skipped, .status.needs_reinstall { color: var(--warn); }
.status.failed, .status.uninstalled { color: var(--bad); }
.bar-cell { width: 50%; min-width: 120px; } .bar { height: 10px; border-radius: 3px; background: var(--accent); min-width: 1px; }
`;

function page(since: string): string {
    const sinceTs = parseSince(since);
    const communities = db.communityReports(sinceTs);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60"><title>${esc(config.botName)} dashboard</title><style>${STYLE}</style></head>
<body><main>
<header>
    <div><h1>${esc(config.botName)}</h1>
    <div class="muted">LLM: ${esc(config.llm.provider)} ${esc(config.llm.model)} · updated ${time(Math.floor(Date.now() / 1000))} UTC</div></div>
    <nav>${PERIODS.map((period) => `<a href="?since=${period}" class="${period === since ? "active" : ""}">${period}</a>`).join("")}</nav>
</header>
${tiles(communities, since)}
${communityTable(communities)}
${dailyChart(db.dailyReports(sinceTs))}
${mentionTable(db.mentionReports(sinceTs, MENTION_ROWS))}
</main></body></html>`;
}

const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/") {
        response.writeHead(404).end();
        return;
    }
    const since = url.searchParams.get("since") ?? "7d";
    try {
        const html = page(since);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    } catch (error) {
        response.writeHead(400, { "content-type": "text/plain" }).end(error instanceof Error ? error.message : String(error));
    }
});

server.listen(Number(values.port), values.host, () => console.log(`dashboard: http://${values.host}:${values.port}/`));

const shutdown = () => {
    server.close();
    db.close();
    process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
