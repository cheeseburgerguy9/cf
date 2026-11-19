# Caitlin Stream — Cloudflare MTProto Proxy

A standalone Cloudflare Worker for the Cloudflare streaming integration already present in the supplied Caitlin Stream / Telegram-Stremio backend.

It is designed to be deployed separately from the application. **Do not edit the application ZIP to install this Worker.** The Worker reads its Telegram API ID/hash and bot pool from the application's existing signed `/api/cf/config` endpoint, and reports traffic to `/api/cf/usage`.

## Worker dashboard

Open the deployed Worker root URL (`https://<worker>.<account>.workers.dev/`) to use the built-in dashboard. Unlock it with the same `SHARED_SECRET` configured for the Worker. The dashboard provides:

- Copy buttons for the Worker URL, shared secret, and Worker name.
- A **Copy both** action that copies the two values Caitlin Stream actually needs (Worker URL + Shared Secret).
- A signed origin-connection test that confirms the app returns its Telegram bot pool.
- Runtime stream-request and byte counters, clearly labelled as isolate-local diagnostics (Cloudflare can run multiple isolates, so these are not account-wide billing totals).
- A traffic-path explanation showing which bytes go through Cloudflare and which small control-plane calls go to the app VPS.

In Caitlin Stream, only **Worker URL** and **Shared Secret** are required. The Worker name/ID is for identifying the deployed script in Cloudflare; there is no separate Worker-ID field in the current app settings.

## What it implements

- Same signed stream URL format emitted by `Backend/helper/cf_stream.py`:
  `/dl/{install-token}/{base62-zlib-stream-id}/{filename}?e={expiry}&s={signature}`
- HMAC-SHA256 verification compatible with the backend's `SHARED_SECRET`.
- Multiple Telegram bot clients. The Worker rotates the first-choice bot and falls back to the remaining configured bots if one cannot read a message.
- MTProto file transfer through GramJS, not the 20 MB Bot API `getFile` download endpoint.
- HTTP `Range`, `206 Partial Content`, `416`, `HEAD`, resume and seeking.
- Concatenated/split media streams.
- ZIP streams containing a stored (uncompressed) media entry, matching the backend's existing ZIP resolver behavior.
- Optional Pyrogram user-session conversion for Global Search streams. The configured user session is used for `global` stream IDs; bots remain the fallback.
- Encrypted-at-rest GramJS session strings in Cloudflare KV.
- Signed config refresh at `/api/sync` and usage/start reporting to `/api/cf/usage`.

## Requirements

- A Cloudflare account with Workers and KV enabled (the free plan is sufficient for initial deployment within its current quotas).
- Node.js 20+ and npm.
- The Caitlin Stream application reachable over HTTPS.
- The Worker URL and shared secret configured in the application's **Settings → Cloudflare Streaming** section.

No Telegram bot token, API ID or API hash needs to be copied into the Worker dashboard. The Worker fetches those from the application over the existing signed backend API.

## Deploy

1. Extract this ZIP and open a terminal in its folder.
2. Install packages:

   ```bash
   npm install
   ```

3. Authenticate Wrangler with Cloudflare:

   ```bash
   npx wrangler login
   ```

4. Create the required free KV namespace and write its ID into `wrangler.toml` automatically:

   ```bash
   npm run setup
   ```

   The setup script creates the `SESSIONS` namespace. Keep the generated ID in `wrangler.toml`; do not share it publicly.

5. Set the application URL and the exact same shared secret configured in the app's Cloudflare Streaming settings:

   ```bash
   npx wrangler secret put ORIGIN_URL
   # Enter the app's public HTTPS base URL, e.g. https://your-app.example.com

   npx wrangler secret put SHARED_SECRET
   # Enter the exact Cloudflare shared secret from Settings → Cloudflare Streaming
   ```

   `ORIGIN_URL` is the **application backend URL**, not the Worker URL. Do not add `/api/cf/config` to it.

6. Deploy:

   ```bash
   npm run deploy
   ```

7. Open the deployed `https://<worker-name>.<account>.workers.dev` URL. Unlock the dashboard with the `SHARED_SECRET` value. Use **Copy both** to copy the exact values for Caitlin Stream.
8. In the application, open **Settings → Cloudflare Streaming** and paste:
   - **Worker URL**: copied from the dashboard
   - **Shared Secret**: copied from the dashboard (same value used for `SHARED_SECRET`)
   - **Stremio Links**: choose **Both** first to test, then **Cloudflare only** once playback is confirmed

9. Save settings. The backend automatically sends a signed `/api/sync` request when its Cloudflare configuration changes.

## Local test

After setting up the KV namespace and secrets, run:

```bash
npm run dev
```

Open `/` for the dashboard, or `/healthz` for the machine-readable health response. The health endpoint should return JSON similar to:

```json
{"ok":true,"service":"Caitlin Stream Cloudflare Proxy","version":"1.0.0"}
```

A health response confirms the Worker is running; it does not by itself confirm Telegram authentication. The first actual stream initializes the bot clients and stores their encrypted GramJS sessions in KV.

## Per-user Worker

The backend's existing per-user Worker feature is supported. Deploy a separate copy of this Worker for the user, set `ORIGIN_URL` to the same application backend, and use the per-user Worker secret saved in the Access panel. The signed `/api/cf/config` request is then resolved by the backend to that user's own bot pool. Do not reuse the owner's shared secret for a per-user Worker.

## Important operational notes

- Every bot used by the Worker must already have access to the media channels, as described in the app README. The Worker cannot grant channel membership.
- Global Search streams use the configured Telegram user session when one is available. The Worker converts the Pyrogram session string returned by the backend into a GramJS session format and encrypts the resulting session in KV.
- Split-file streams are concatenated in their original order. ZIP support follows the backend's existing stored-entry extraction behavior; compressed ZIP entries are not transcoded by this Worker.
- **Video payload path:** player → Cloudflare Worker → Telegram MTProto, then Cloudflare Worker → player. The Worker does not fetch video bytes from the Caitlin Stream VPS and does not redirect the player to the app's `/dl` endpoint. The app VPS is contacted only for the signed `/api/cf/config` response and small `/api/cf/usage` reports, so the VPS does not carry the video payload or its egress bandwidth.
- Cloudflare Free is quota-limited, not unlimited. The Worker does not store video in R2 or require a paid storage service. Check your account's current Workers and KV quotas before sharing the Worker with many viewers.
- Telegram may apply FloodWaits or per-bot limits. The Worker rotates through the configured bot pool, but it cannot bypass Telegram's own rate limits.

## Troubleshooting

| Symptom | Check |
|---|---|
| `401` / invalid signature | The Worker `SHARED_SECRET` must exactly match the app setting. Check `ORIGIN_URL` and clock accuracy. |
| `Origin config request failed` | Ensure `ORIGIN_URL` is the public HTTPS app base URL and `/api/cf/config` is reachable. |
| `No bot tokens were returned` | Confirm the app has its main bot configured; for per-user Workers, verify the user's own bots. |
| `All configured Telegram bots failed` | Confirm each bot is an admin/member in the source media channels and check the app/Worker logs. |
| `Invalid Telegram user session` | Reconnect the Telegram user session in the app, then save settings to trigger `/api/sync`. |
| Seeking returns `416` | The player sent an invalid or unsatisfiable range; try another player and inspect its `Range` header. |

## Security

- Keep `SHARED_SECRET` private. It authorizes the Worker to fetch the Telegram bot pool and report usage, and it unlocks the private dashboard. Do not publish screenshots showing the revealed secret.
- Telegram bot tokens and the optional user session are fetched from the backend over HTTPS and never returned to stream clients.
- GramJS sessions are encrypted before they are stored in KV, using a key derived from `SHARED_SECRET`.
- Signed stream links expire after the backend's configured 48-hour link TTL.
- Do not commit `.dev.vars`, Cloudflare API tokens, or secrets.
