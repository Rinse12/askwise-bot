const UNITS: Record<string, number> = { h: 3600, d: 86400, w: 604800 };

// "24h", "7d", "4w" or "all" as a unix timestamp that many hours/days/weeks ago (0 for all)
export function parseSince(since: string, nowTs = Math.floor(Date.now() / 1000)): number {
    if (since === "all") return 0;
    const match = since.match(/^(\d+)([hdw])$/);
    if (!match) throw new Error(`--since must look like 24h, 7d, 4w or all`);
    return nowTs - Number(match[1]) * UNITS[match[2]];
}
