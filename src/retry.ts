import type { Limits } from "./config.js";

export type RetryLimits = Pick<Limits, "mentionMaxAgeHours" | "mentionMaxAttempts" | "retryBaseSeconds">;

export const isTooOld = (mentionTimestamp: number, limits: RetryLimits, nowTs: number) => nowTs - mentionTimestamp > limits.mentionMaxAgeHours * 3600;

// When to try a mention again; undefined means give up.
export function nextAttemptAt(
    outcome: { kind: "rate_limited" } | { kind: "failed"; attempts: number; retryable: boolean },
    mentionTimestamp: number,
    limits: RetryLimits,
    nowTs: number
): number | undefined {
    const at =
        outcome.kind === "rate_limited"
            ? nowTs + limits.retryBaseSeconds * 10
            : outcome.retryable && outcome.attempts < limits.mentionMaxAttempts
              ? nowTs + limits.retryBaseSeconds * 2 ** (outcome.attempts - 1)
              : undefined;
    // no point retrying past the age at which the mention would be skipped anyway
    return at !== undefined && !isTooOld(mentionTimestamp, limits, at) ? at : undefined;
}
