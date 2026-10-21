# TODO

- [ ] **Switch the LLM from the Claude Code CLI to the API** (`LLM_PROVIDER=anthropic-api` with an `ANTHROPIC_API_KEY`).
  - The bot currently runs on `LLM_PROVIDER=claude-code`, i.e. the local `claude` CLI and its Claude subscription.
  - **Account details:** Claude Code injects the logged-in account's email and org id into every session, and nothing turns that off while keeping subscription login. The reply check (`src/llm/private-info.ts`) keeps them out of published replies, but they still reach the model. The API sends no account context.
  - **Terms:** Anthropic doesn't allow serving other people's requests through Free/Pro/Max plan credentials ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md)).
  - **Cost:** the API is billed per token. Haiku 5.5 is $0.10 / $0.50 per MTok, and `LIMIT_GLOBAL_USD_PER_DAY` caps the daily spend.
  - **Steps:** set the two variables in `.env`, check the `LLM_INPUT_PRICE_PER_MTOK` / `LLM_OUTPUT_PRICE_PER_MTOK` values, then `systemctl --user restart askwise-bot` and watch the first replies.
  - **Then remove the claude-code backend** (`src/llm/claude-code.ts`, `LLM_PROVIDER=claude-code`, the `claude auth status` account check and its README section), so nobody runs a public bot on a subscription.

- [ ] **Web search**, so answers can use current information (like Grok).
  - Use the provider's server-side web search tool: it runs on the provider's side, so nothing runs on the bot's machine.
  - At most 3 searches per reply, and searches are billed per use: record their cost in `llm_usage` so `LIMIT_GLOBAL_USD_PER_DAY` still holds.
  - Leave web fetch out: following links users post is the easiest way in for prompt injection.
  - Then drop "You cannot browse the web" from the system prompt.

- [ ] **Set the avatar** on seedit: blocked on bitsocialnet/seedit#853, steps in [#1](https://github.com/Rinse12/askwise-bot/issues/1).
