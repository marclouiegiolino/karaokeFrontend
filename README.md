# Karaoke Frontend

TypeScript Next.js App Router frontend for the existing Karaoke API. The UI includes cookie-based sign-in, song search, audio playback/seeking, and an administrator upload flow.

## CPU-conscious hosting design

- `next build` creates a static export in `out/`; there is no Next.js server rendering or frontend API route at runtime.
- Cloudflare serves static assets directly. The small Worker in `src/worker.ts` runs only for `/api/*` and proxies those requests to the existing backend, keeping the session cookie same-origin in the browser.
- Audio and package bytes are sent from the browser directly to presigned R2 URLs. Audio playback also uses the backend's temporary R2 URL, so the frontend Worker does not proxy media bytes.
- The API proxy handles small JSON control-plane requests. Its production CPU still needs to be checked in Cloudflare logs after deployment; local build results do not prove production CPU.

## Local development

Use Node.js 22.12 or newer.

1. Start the backend locally from `C:\Karaoke\backend` using its documented dev command. The API should be available at `http://localhost:8787/api`.
2. In this folder, copy `.env.development.local.example` to `.env.development.local`.
3. Install and run:

   ```powershell
   npm ci
   npm run dev
   ```

4. Open `http://localhost:3000`. The browser calls the local backend. The backend's development CORS origin must include `http://localhost:3000`.

For a local test of the Cloudflare static Worker proxy instead, run `npm run dev:edge`. It builds the static export, serves it at `http://localhost:3000`, and proxies `/api/*` to `http://localhost:8787` using the separate `wrangler.dev.jsonc` config. This keeps local requests away from production.

## Backend API behavior

The UI follows the backend contract in `C:\Karaoke\backend\docs\API.md`:

- `POST /auth/login`, `GET /auth/me`, and `POST /auth/logout` use the backend's HttpOnly session cookie.
- Signed-in users can search published songs and get a temporary audio URL from `GET /songs/:id/download`.
- Admins can create drafts, request upload intents, PUT files directly to R2, complete each upload, and publish a song.
- Upload package JSON must match the backend scoring-package schema. The UI leaves package validation to the backend and displays its error response.

If backend request or response schemas change, update `src/lib/api.ts` and the corresponding UI flow from the backend's current contract.

## Before production deployment

1. Ensure the production backend allows the exact origin Cloudflare assigns to this frontend in `FRONTEND_ORIGINS`.
2. Add that same exact origin to the `karaoke-media` R2 CORS policy. Permit browser `PUT`, `GET`, and `HEAD`; allow the upload `Content-Type` header and byte-range requests; expose `ETag`, `Content-Length`, `Content-Range`, and `Accept-Ranges` as needed by the existing backend/R2 flow.
3. Confirm `BACKEND_API_ORIGIN` in `wrangler.jsonc` points to the intended backend Worker. It is a public endpoint, not a secret.
4. Run `npm run check`, then deploy when ready:

   ```powershell
   npm run deploy
   ```

The deploy command builds and checks the app before publishing the `karaoke-frontend` Worker. It does not configure backend CORS or R2 CORS for you. After deployment, test sign-in, catalog search, a small admin upload, playback, and seeking, then inspect the frontend Worker CPU logs for `/api/*` requests.

## Verification commands

```powershell
npm run lint
npm run typecheck
npm run build
npx wrangler deploy --dry-run
```

The static page itself has no Worker server-rendering path. API proxy invocations still use Cloudflare Worker CPU, so only deployed Cloudflare logs can confirm how much CPU they consume.
