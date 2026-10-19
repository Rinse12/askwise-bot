import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LlmRefusalError } from "./types.js";

// A reply that would reveal the operator's private details (e.g. the Claude account email that Claude Code
// injects into every session). It is never published and never retried.
export class PrivateInfoBlockedError extends LlmRefusalError {}

// Lowercase and undo common ways of disguising an address ("x at y dot com", spaced-out letters), so a
// secret is found however it is spelled out.
const normalize = (text: string) =>
    text
        .toLowerCase()
        .replace(/\s*[[(]?\s*\bat\b\s*[\])]?\s*/g, "@")
        .replace(/\s*[[(]?\s*\bdot\b\s*[\])]?\s*/g, ".")
        .replace(/[\s"'`*_~|\\-]+/g, "");

const normalizeSecret = (secret: string) => secret.toLowerCase().replace(/[\s"'`*_~|\\-]+/g, "");

// The private strings found in a reply, by their index in `secrets` (the strings themselves are not echoed).
export function findPrivateInfo(text: string, secrets: string[]): number[] {
    const haystack = normalize(text);
    return secrets.flatMap((secret, index) => {
        const needle = normalizeSecret(secret);
        return needle.length >= 4 && haystack.includes(needle) ? [index] : [];
    });
}

// An email address plus its local part (the part most likely to be quoted on its own), when it is long
// enough not to match ordinary words.
export function emailSecrets(email: string): string[] {
    const local = email.split("@")[0];
    return local.length >= 6 ? [email, local] : [email];
}

// The account details Claude Code puts in every session: the logged-in email and the organization id.
export async function claudeCodeAccountSecrets(bin: string): Promise<string[]> {
    const { stdout } = await promisify(execFile)(bin, ["auth", "status", "--json"], { timeout: 30_000 });
    const status = JSON.parse(stdout) as { email?: string; orgId?: string; orgName?: string };
    return [...(status.email ? emailSecrets(status.email) : []), ...(status.orgId ? [status.orgId] : [])];
}
