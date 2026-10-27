import type { ThreadImage } from "../images.js";

export interface LlmReply {
    text: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
}

export interface LlmRequest {
    community: string;
    // community.rules as the owner published them; the reply has to follow them
    rules: string[];
    threadContext: string;
    // images posted in the thread, closest to the calling comment first
    images: ThreadImage[];
}

// Swap the provider by implementing this; usage is reported per call so it can be tracked in sqlite.
export interface LlmClient {
    reply(request: LlmRequest): Promise<LlmReply>;
}

export class LlmRefusalError extends Error {}
