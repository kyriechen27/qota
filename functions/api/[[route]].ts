// Cloudflare Pages Functions entrypoint.
//
// Runs the EXISTING Hono API (apps/worker/src/index.ts) as Pages Functions.
// Pages routes /api/* to this catch-all; everything else is served as static
// assets from the same Pages project (the built SPA in apps/web/dist). Because
// the SPA and the API share one origin, the front-end's relative `/api/...`
// calls work with no cross-domain / CORS setup.
//
// Connect this repo to Cloudflare Pages and every push auto-deploys. The
// standalone Worker target (apps/worker/wrangler.toml) still works unchanged.

import { handle } from 'hono/cloudflare-pages';
import app from '../../apps/worker/src/index';

export const onRequest = handle(app);
