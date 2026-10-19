import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The repo's .env, loaded once by every entry point (bot, install script, usage report, ...).
// Variables already set in the environment win over the file.
export const ENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));
let envLoaded = false;
export function loadEnvFile() {
    if (envLoaded) return;
    envLoaded = true;
    if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
}

export interface Limits {
    communityRepliesPerHour: number;
    communityTokensPerDay: number;
    authorMentionsPerHour: number;
    globalUsdPerDay: number;
    maxBotRepliesInThread: number;
}

export interface Config {
    pkcRpcUrl: string;
    // when set, pkc RPC is reached through `ssh -N -L` to this host (a ~/.ssh/config alias works), and pkcRpcUrl is ignored
    pkcRpcSshHost: string | undefined;
    // host:port of the RPC as seen from that ssh host
    pkcRpcSshRemote: string;
    botName: string;
    botDisplayName: string;
    registryAddress: string | undefined;
    dataDir: string;
    // http(s):// or socks5:// proxy for downloading thread images; unset lets Anthropic fetch them by URL
    imageProxyUrl: string | undefined;
    llm: {
        // anthropic-api: Messages API with ANTHROPIC_API_KEY. claude-code: the local `claude` CLI and its subscription login.
        provider: "anthropic-api" | "claude-code";
        claudeCodeBin: string;
        model: string;
        effort: "low" | "medium" | "high" | "xhigh" | "max";
        inputPricePerMTok: number;
        outputPricePerMTok: number;
        maxImages: number;
    };
    limits: Limits;
}

const num = (env: NodeJS.ProcessEnv, key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${key} must be a number, got "${raw}"`);
    return value;
};

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const PROVIDERS = ["anthropic-api", "claude-code"] as const;

export function loadConfig(env?: NodeJS.ProcessEnv): Config {
    if (!env) {
        loadEnvFile();
        env = process.env;
    }
    const provider = env.LLM_PROVIDER || "anthropic-api";
    if (!(PROVIDERS as readonly string[]).includes(provider)) throw new Error(`LLM_PROVIDER must be one of ${PROVIDERS.join(", ")}`);
    const effort = env.LLM_EFFORT || "medium";
    if (!(EFFORTS as readonly string[]).includes(effort)) throw new Error(`LLM_EFFORT must be one of ${EFFORTS.join(", ")}`);
    return {
        pkcRpcUrl: env.PKC_RPC_URL || "ws://localhost:9138",
        pkcRpcSshHost: env.PKC_RPC_SSH_HOST || undefined,
        pkcRpcSshRemote: env.PKC_RPC_SSH_REMOTE || "127.0.0.1:9138",
        botName: (env.BOT_NAME || "bitsocialbot.bso").toLowerCase(),
        botDisplayName: env.BOT_DISPLAY_NAME || "Bitsocial Bot",
        registryAddress: env.REGISTRY_ADDRESS || undefined,
        dataDir: path.resolve(env.DATA_DIR || "data"),
        imageProxyUrl: env.IMAGE_PROXY_URL || undefined,
        llm: {
            provider: provider as Config["llm"]["provider"],
            claudeCodeBin: env.CLAUDE_CODE_BIN || "claude",
            model: env.LLM_MODEL || "claude-haiku-5-5",
            effort: effort as Config["llm"]["effort"],
            inputPricePerMTok: num(env, "LLM_INPUT_PRICE_PER_MTOK", 0.1),
            outputPricePerMTok: num(env, "LLM_OUTPUT_PRICE_PER_MTOK", 0.5),
            maxImages: num(env, "LLM_MAX_IMAGES", 4)
        },
        limits: {
            communityRepliesPerHour: num(env, "LIMIT_COMMUNITY_REPLIES_PER_HOUR", 30),
            communityTokensPerDay: num(env, "LIMIT_COMMUNITY_TOKENS_PER_DAY", 500_000),
            authorMentionsPerHour: num(env, "LIMIT_AUTHOR_MENTIONS_PER_HOUR", 5),
            globalUsdPerDay: num(env, "LIMIT_GLOBAL_USD_PER_DAY", 20),
            maxBotRepliesInThread: num(env, "LIMIT_MAX_BOT_REPLIES_IN_THREAD", 3)
        }
    };
}
