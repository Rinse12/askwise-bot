import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import type { ImageLoader } from "../images.js";
import { buildContent, contentWithoutFailedImages, costUsd, type ContentBlock } from "./content.js";
import { LlmRefusalError, type LlmClient, type LlmReply, type LlmRequest } from "./types.js";

// Calls the Messages API with ANTHROPIC_API_KEY (or an `ant auth login` profile), billed per token.
export class AnthropicLlmClient implements LlmClient {
    private client = new Anthropic();

    constructor(
        private llmConfig: Config["llm"],
        private images: ImageLoader,
        private systemPrompt: string
    ) {}

    private create(content: ContentBlock[]) {
        return this.client.beta.messages.create({
            model: this.llmConfig.model,
            max_tokens: 16000,
            output_config: { effort: this.llmConfig.effort },
            // On a policy decline the API re-runs the request on a fallback model inside the same call.
            // Haiku has no server-side fallback, so a refusal there just ends the request.
            ...(/haiku/.test(this.llmConfig.model) ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
            system: this.systemPrompt,
            messages: [{ role: "user", content }]
        });
    }

    async reply(request: LlmRequest): Promise<LlmReply> {
        const content = await buildContent(request, this.images, this.llmConfig.maxImages);
        let response;
        const attempts = [content, ...contentWithoutFailedImages(content)];
        for (const [index, attempt] of attempts.entries()) {
            try {
                response = await this.create(attempt);
                break;
            } catch (error) {
                // A 400 with images in the request is most likely an image URL Anthropic could not fetch
                if (!(error instanceof Anthropic.BadRequestError) || index === attempts.length - 1) throw error;
                if (index === 0) console.warn(`an image could not be loaded, retrying without it: ${error.message}`);
            }
        }
        if (!response) throw new Error("unreachable: no response");

        const usage = {
            input: response.usage.input_tokens,
            output: response.usage.output_tokens,
            cacheRead: response.usage.cache_read_input_tokens ?? 0,
            cacheWrite: response.usage.cache_creation_input_tokens ?? 0
        };
        const reply: LlmReply = {
            text: response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim(),
            // The model that served the reply, which differs from the configured one after a fallback
            model: response.model,
            inputTokens: usage.input,
            outputTokens: usage.output,
            cacheReadTokens: usage.cacheRead,
            cacheWriteTokens: usage.cacheWrite,
            costUsd: costUsd(usage, this.llmConfig)
        };
        if (response.stop_reason === "refusal") throw Object.assign(new LlmRefusalError(`LLM refused: ${response.stop_details?.category ?? "unknown"}`), { reply });
        return reply;
    }
}
