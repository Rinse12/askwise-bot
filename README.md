# @bitsocialbot

An AI reply bot for Bitsocial communities, in the spirit of "@grok is this true?". It only works in communities that explicitly installed it. In those, anyone can mention `@bitsocialbot` (or `bitsocialbot.bso` / `u/bitsocialbot.bso`) in a post or a reply, and the bot answers in the thread. It reads the thread and any images posted in it.

## How it fits into pkc-js

- **Installing = exempting the bot's name from the community's challenges.** Every challenge in `settings.challenges` gets this exclude item:

  ```json
  { "names": ["bitsocialbot.bso"], "publicationType": { "reply": true } }
  ```

  pkc-js only applies it when a publication's `author.name` is exactly `bitsocialbot.bso` **and** that name currently resolves to the key that signed it. So the exemption follows the wallet that owns the name, not a signing key that could leak. Rotating the key is just re-pointing the name; no community has to do anything.
  - The bot only publishes replies, and the exemption covers only replies.
  - Your own users are still challenged exactly as before.
  - This is *not* the `whitelist` challenge, which would lock out everyone not on the list.
- **Excludes are public**, so the bot checks for itself that a community installed it. If an owner adds a challenge later without the exemption, the bot notices, stops answering there, and resumes once the install script is re-run.
- **Registering:** after installing, the owner or an admin posts the community address in the registry community. The bot checks two things, that the poster has the `owner`/`admin` role and that the excludes are in place, then replies ✅ or ❌ and starts watching.
- **Mentions** are found by walking whatever page sorts the community publishes. No particular sort (`new`, `hot`, …) is assumed. Pages are content-addressed, so already-walked pages are never fetched twice.

## Install @bitsocialbot in your community

Requirements: the community runs on a [bitsocial-cli](https://github.com/bitsocialnet/bitsocial-cli) daemon **on this machine** (pkc RPC at `ws://localhost:9138`), and Node.js 22+.

```sh
git clone https://github.com/bitsocialnet/Bitsocial-bot.git && cd Bitsocial-bot
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

## Self-hosting your own bot

You can run your own instance under your own `.bso` name, e.g. `yourbot.bso`. Communities install your bot by passing your name to the install script:

```sh
BOT_NAME=yourbot.bso npm run install-bot -- --community <address>
```

### 1. Requirements

- A machine that stays online, with Node.js 22+ (nvm recommended).
- A [bitsocial-cli](https://github.com/bitsocialnet/bitsocial-cli) daemon for the bot to read and publish through. It does not need to host any community except the registry.

  ```sh
  npm install -g @bitsocial/bitsocial-cli
  bitsocial daemon        # pkc RPC on ws://localhost:9138
  ```

  Or use the Docker setup from the bitsocial-cli README. If the daemon runs on another machine, use its `ws://host:9138/<auth-key>` URL as `PKC_RPC_URL`.
- An Anthropic API key (`ANTHROPIC_API_KEY`), or `ant auth login` on the bot machine.
- Your own `.bso` name, e.g. `yourbot.bso`. `.bso` is the protocol's name system and it sits on ENS: to get `yourbot.bso`, register `yourbot.eth` at [app.ens.domains](https://app.ens.domains) with an Ethereum wallet. You set the record on the `.eth` side (step 3), but everywhere in Bitsocial, including `BOT_NAME` and the communities' excludes, you write it as `yourbot.bso`.
  - pkc-js compares exclude names as exact strings, so always use the same lowercase `.bso` spelling.

### 2. Install the bot

```sh
git clone https://github.com/bitsocialnet/Bitsocial-bot.git && cd Bitsocial-bot
npm ci
cp .env.example .env
```

### 3. Create the bot's key and point your name at it

```sh
npm run create-signer
```

- This needs no running node. It writes `data/bot-signer.json` (the private key, readable only by you) and prints an address like `12D3KooW...`.
- In the ENS app, from the wallet that owns `yourbot.eth`, add a text record:
  - key `bitsocial`
  - value: the `12D3KooW...` address

  That is what makes `yourbot.bso` resolve to the bot's key.
- Back up `data/bot-signer.json`. If the key ever leaks, run `create-signer` again (after moving the old file away) and re-point the name. Communities don't have to change anything, because they exempt the name, not the key.

### 4. Create the registry community

On your daemon:

```sh
bitsocial community create --title "Bitsocial bot registry" --description "Post your community address here to activate the bot"
```

- Give it no challenges, or run `npm run install-bot -- --community <registry-address>` so the bot can reply there.
- To show a bot badge on the bot's replies, enable author flairs and add a `🤖 bot` author flair (see "Optional bot badge" above).

### 5. Configure `.env`

| Variable | What it is |
|---|---|
| `PKC_RPC_URL` | your daemon, default `ws://localhost:9138` |
| `BOT_NAME` / `BOT_DISPLAY_NAME` | your name (`yourbot.bso`) and the display name shown on replies |
| `REGISTRY_ADDRESS` | the registry community from step 4 |
| `ANTHROPIC_API_KEY` | unless you used `ant auth login` |
| `LLM_MODEL` | defaults to `claude-haiku-5-5`, the cheapest Claude model. Set e.g. `claude-opus-5-5` for better answers, and update `LLM_INPUT_PRICE_PER_MTOK` / `LLM_OUTPUT_PRICE_PER_MTOK` so cost tracking stays right. |
| `IMAGE_PROXY_URL` | optional, see "Images and privacy" |
| `LIMIT_*` | spend and rate limits; the daily spend cap defaults to $20 |

Optionally add `data/author-profile.json` with `displayName`, an `avatar` (NFT) or `wallets`. Avatar and wallet entries must be signed offline by the wallet that owns the name.

### 6. Run it

```sh
npm start
```

- The bot refuses to start until your name resolves to its key.
- To keep it running, use a systemd user service:

  ```ini
  # ~/.config/systemd/user/bitsocialbot.service
  [Unit]
  Description=Bitsocial bot
  After=network-online.target

  [Service]
  WorkingDirectory=%h/Bitsocial-bot
  ExecStart=/usr/bin/env npm start
  Restart=always
  RestartSec=10

  [Install]
  WantedBy=default.target
  ```

  ```sh
  systemctl --user enable --now bitsocialbot
  loginctl enable-linger "$USER"   # keep it running after you log out
  journalctl --user -u bitsocialbot -f
  ```

- All state is in `data/`: the key, `bitsocialbot.db` (installed communities, handled mentions, token usage) and the optional profile. Back up that folder to move the bot to another machine.

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
