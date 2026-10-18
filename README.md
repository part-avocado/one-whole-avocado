# one whole avocado

A Slack bouncer bot (Bolt for JS, Socket Mode).

1. A user runs `/channelrequest <reason>` in `C0C26M2E3FT` (anywhere else it refuses).
2. The bot DMs `U0A06EPFV45` with the user's ID, a ping, the reason, and Approve / Reject buttons.
3. **Approve** DMs the user a **Sign attestation** button. It opens a modal where they must type the attestation, mentioning themselves with `@`. Matching is word by word and ignores case, spacing and punctuation. A few misspelled words still pass, but a missing, extra or changed word doesn't (dropping a "not" changes the meaning). Attempts with up to 10 such errors go to `U0A06EPFV45` with **Accept** / **Make them retry** buttons; anything worse shows where it stops matching so they can retry. Once it's accepted, the bot adds them to `C0C962U4JSW`, updates the approval message, and posts the signed attestation to `U0A06EPFV45` in that message's thread (also shown in the DM). Signed attestations are logged in `ATTESTATIONS_FILE` (default `data/attestations.json`). **Reject** does nothing visible to the user.

4. If a user leaves `C0C26M2E3FT`, the bot also removes them from `C0C962U4JSW` and cancels any unsigned attestation.

Only `U0A06EPFV45` can act on the buttons. IDs are constants at the top of `src/app.js`.

## Setup

1. https://api.slack.com/apps → **Create New App** → **From a manifest**, paste `manifest.json`.
2. **Install App**, copy the Bot User OAuth Token (`xoxb-…`).
3. **Basic Information → App-Level Tokens** → generate one with `connections:write` (`xapp-…`).
4. `cp .env.example .env`, fill in both tokens.
5. **Invite the bot to `C0C962U4JSW`** (`/invite @one whole avocado`) — it can't add people to a channel it isn't in.
6. `npm install && npm start`

## Docker

Socket Mode makes only outbound connections, so no ports are exposed.

```
cp .env.example .env   # fill in both tokens
docker compose up -d --build
docker compose logs -f
```

`restart: unless-stopped` brings the bot back after crashes and VM reboots.

## Chat commands

Send these as a plain message in any channel the bot is in (optionally in a thread):

- `?help` — summary of all commands and features.
- `?ping` — Slack API round-trip and event delivery latency.
- `?info` — host / container / runtime details.
- `?build` — version, git commit, start time, uptime, Node/Bolt versions, and error count with the last few errors. In Docker the commit comes from `GIT_COMMIT`; run `./deploy.sh` after `git pull` to rebuild with it set (plain `docker compose up --build` shows `unknown`).
- `?time <reminder>` — sends the text to Gemini (needs `GEMINI_API_KEY`; model via `GEMINI_MODEL`, default `gemini-3.6-flash`) and replies with JSON `{date, time, message}`. Date/time are UTC, converted from the sender's Slack timezone; `message` is the original wording minus scheduling words. Needs the `users:read` scope (reinstall the app after updating the manifest). It then confirms the local date/time and, when that moment arrives, pings the sender in the same channel/thread with the message. Pending reminders persist in `REMINDERS_FILE` (default `data/reminders.json`; `/data/reminders.json` in Docker, on the `reminders` volume). Each reminder gets an id: `?time -a` lists your active reminders and `?time <id> delete` (or `cancel`) removes one of yours.
