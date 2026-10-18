# jfunk42 Patreon authentication Worker

This Cloudflare Worker securely determines whether a jfunk42.com visitor is logged in to Patreon and returns a server-verified membership tier. It intentionally never exposes Patreon access tokens, client secrets, Patreon account details, or raw user IDs to the static site.

## Endpoints

- `GET /auth/patreon`: begins Patreon OAuth.
- `GET /auth/patreon/callback`: validates state, retrieves the active membership, creates a seven-day HTTP-only session, then redirects to the feature-request page.
- `GET /api/session`: returns `{ "authenticated": false }` or the verified tier label and session expiry.
- `POST /api/logout`: revokes the server-side session and clears the cookie.
- `GET /health`: readiness endpoint.

## First deployment

1. Install dependencies: `npm install`.
2. Authenticate Cloudflare: `npx wrangler login`.
3. Create the database: `npx wrangler d1 create jfunk42-patreon-auth`.
4. Copy the returned `database_id` into `wrangler.jsonc`.
5. Create all Worker secrets; do not place their values in this repository:

   ```sh
   npx wrangler secret put PATREON_CLIENT_ID
   npx wrangler secret put PATREON_CLIENT_SECRET
   npx wrangler secret put AUTH_HASH_KEY
   npx wrangler secret put PATREON_TIER_MAP
   ```

   Generate `AUTH_HASH_KEY` with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. `PATREON_TIER_MAP` is a JSON object mapping Patreon tier IDs to the labels shown by the site, for example `{"123456":"Pi"}`.

6. Deploy: `npm run deploy`.
7. Add `api.jfunk42.com` as the Worker's custom domain in Cloudflare. The Worker and main site must share the `jfunk42.com` site so the secure session cookie can be sent on API calls.
8. In the Patreon developer portal, add this exact redirect URI: `https://api.jfunk42.com/auth/patreon/callback`.
9. Update the static feature board to use `https://api.jfunk42.com/auth/patreon` for login and `https://api.jfunk42.com/api/session` for status.

The current local Patreon credential file is intentionally not read or copied by this project. Use it only as input to the interactive `wrangler secret put` commands, so credentials remain outside Git and Worker source.
