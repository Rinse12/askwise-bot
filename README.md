# @bitsocialbot

An AI reply bot for Bitsocial communities, in the spirit of "@grok is this true?". It only works in communities that explicitly installed it. In those, anyone can mention `@bitsocialbot` (or `bitsocialbot.eth` / `u/bitsocialbot.eth`) in a post or a reply, and the bot answers in the thread. It reads the thread and any images posted in it.

## How it fits into pkc-js

- **Installing = exempting the bot's name from the community's challenges.** Every challenge in `settings.challenges` gets this exclude item:

  ```json
  { "names": ["bitsocialbot.eth"], "publicationType": { "reply": true } }
  ```

  pkc-js only applies it when a publication's `author.name` is `bitsocialbot.eth` **and** that name currently resolves to the key that signed it. So the exemption follows the wallet that owns the name, not a signing key that could leak. Rotating the key is just re-pointing the name; no community has to do anything.
  - The bot only publishes replies, and the exemption covers only replies.
  - Your own users are still challenged exactly as before.
  - This is *not* the `whitelist` challenge, which would lock out everyone not on the list.
- **Excludes are public**, so the bot checks for itself that a community installed it. If an owner adds a challenge later without the exemption, the bot notices, stops answering there, and resumes once the install script is re-run.
- **Registering:** after installing, the owner or an admin posts the community address in the registry community. The bot checks two things, that the poster has the `owner`/`admin` role and that the excludes are in place, then replies ✅ or ❌ and starts watching.
- **Mentions** are found by walking whatever page sorts the community publishes. No particular sort (`new`, `hot`, …) is assumed. Pages are content-addressed, so already-walked pages are never fetched twice.

## Install @bitsocialbot in your community

Requirements: the community runs on a [bitsocial-cli](https://github.com/bitsocialhq/bitsocial-cli) daemon **on this machine** (pkc RPC at `ws://localhost:9138`), and Node.js 22+.

```sh
git clone <this repo> bitsocialbot && cd bitsocialbot
npm ci

# preview the change, then apply it
npm run install-bot -- --community <your-community-address> --dry-run
npm run install-bot -- --community <your-community-address>
```

- The script only edits challenges that don't exempt the bot yet. **Run it again whenever you add challenges.**
- Use `--rpc ws://host:port/<auth-key>` if your daemon is elsewhere.

Then, from the owner or an admin account, make a post in the registry community whose content is just your community address. The bot replies ✅ when it is active.

**Optional bot badge.** A community only accepts author flairs it lists itself. To have the bot's replies show a bot flair, enable `features.authorFlairs` and add an author flair whose text contains "bot" (e.g. `🤖 bot`) to `flairs.author`. The bot uses it automatically.

**Uninstall:**

```sh
npm run install-bot -- --community <your-community-address> --uninstall
```

The bot sees the change on the community's next update and stops answering.

## Running the bot (operator)

1. `cp .env.example .env` and fill in:
   - `REGISTRY_ADDRESS`
   - `ANTHROPIC_API_KEY` (or log in with `ant auth login`)
   - `LLM_MODEL`: defaults to `claude-haiku-5-5`, the cheapest Claude model; set e.g. `claude-opus-5-5` for better answers (and update the prices used for cost tracking)
   - optionally the limits and pricing
2. `npm run create-signer` creates `data/bot-signer.json` and prints its address. From the wallet that owns `bitsocialbot.eth`, point the name at that address. The bot refuses to start while the name resolves elsewhere.
3. Optionally add `data/author-profile.json` with `displayName`, `avatar` (NFT) or `wallets`. Avatar and wallet signatures are made offline with the name-owning wallet.
4. Create the registry community on your node. Either give it no challenges, or install the bot in it like any other community.
5. `npm start`

Every bot publication carries `author.name`, `displayName`, `previousCommentCid` (chained across all of its comments) and, where the community offers one, a bot flair.

### Images and privacy

The bot shows the LLM up to `LLM_MAX_IMAGES` images from the thread: post image links, markdown images, and pasted image URLs. The bot's machine never loads them directly:

- **Default (no `IMAGE_PROXY_URL`):** the image URL is passed to Claude and Anthropic's servers fetch it.
- **`IMAGE_PROXY_URL=socks5://127.0.0.1:9050`** (Tor) **or `http://proxy:port`:** the bot downloads the image through the proxy and sends the bytes inline. Private and LAN addresses are refused, and images must be jpeg/png/gif/webp under 5 MB.

If an image can't be loaded, the bot answers without it and says so to the model.

### Limits and token tracking

All LLM calls are recorded in `data/bitsocialbot.db` (`llm_usage`: tokens, model, cost per mention). Before calling the LLM, the bot enforces:

- replies per community per hour
- tokens per community per day
- mentions per author per hour
- a global daily spend cap
- a cap on bot replies per thread, to avoid loops

```sh
npm run usage -- --since 7d --by community   # or --by author / --by model, --since 24h / 4w / all
```

## Development

```sh
npm test           # unit tests
npm run typecheck
npm run e2e        # full flow against a local Kubo + in-process pkc RPC node, with a fake LLM (needs `ipfs` on PATH or KUBO_BIN)
```
