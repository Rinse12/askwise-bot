export interface MentionableComment {
    cid: string;
    title?: string;
    content?: string;
    depth?: number;
    parentCid?: string;
    author?: { address?: string; name?: string; displayName?: string };
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Matches `@askwise`, `@askwise.bso`, `askwise.bso` and `u/askwise.bso`
// (the .eth spelling of the name is accepted too). A bare `askwise` without @ is not a call.
export function createMentionRegex(botName: string): RegExp {
    const label = escapeRegex(botName.split(".")[0]);
    const tld = "\\.(?:eth|bso)";
    return new RegExp(`(?<![\\w@/.-])(?:@${label}(?:${tld})?|(?:u/)?${label}${tld})(?![\\w-]|\\.\\w)`, "i");
}

// Posts can call the bot in the title or the content, replies only have content.
export function mentionsBot(comment: MentionableComment, regex: RegExp): boolean {
    return regex.test(comment.title ?? "") || regex.test(comment.content ?? "");
}

const authorLabel = (comment: MentionableComment) =>
    comment.author?.displayName ? `${comment.author.displayName} (${comment.author.address ?? "?"})` : comment.author?.address ?? "unknown";

const renderComment = (comment: MentionableComment) =>
    [comment.title ? `Title: ${comment.title}` : undefined, comment.content ?? ""].filter((part) => part !== undefined).join("\n");

// Builds the text the LLM sees: the thread from the post down to the comment that called the bot.
// `ancestors` is ordered from the post to the direct parent; empty when the mention is the post itself.
export function buildThreadContext(mention: MentionableComment, ancestors: MentionableComment[]): string {
    const parts = ancestors.map(
        (comment, index) => `[${index === 0 ? "post" : `reply depth ${comment.depth ?? index}`}] ${authorLabel(comment)}:\n${renderComment(comment)}`
    );
    parts.push(`[comment calling you] ${authorLabel(mention)}:\n${renderComment(mention)}`);
    return parts.join("\n\n---\n\n");
}
