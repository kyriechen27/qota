// Cloudflare Pages "advanced mode" entry. `npm run pages:build` bundles this
// (with all npm deps inlined) into apps/web/dist/_worker.js, and that built dir
// is committed to the repo.
//
// Why: like the remote-file project, this lets Cloudflare Pages deploy with an
// EMPTY build command — it just serves the committed apps/web/dist (static SPA
// + _worker.js), no `npm install` / build needed on Cloudflare. Rerun
// `npm run pages:build` and commit before pushing whenever the app/web changes.
//
// Routing: /api/* → the existing Hono app; everything else → the static SPA via
// the ASSETS binding (same origin, so the front-end's relative /api works).

import app from './src/index';
import type { Bindings } from './src/env';

interface PagesEnv extends Bindings {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: PagesEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return app.fetch(request, env, ctx);
    }
    const asset = await env.ASSETS.fetch(request);
    // SPA fallback: serve index.html for unknown client-side routes.
    if (
      asset.status === 404 &&
      request.method === 'GET' &&
      (request.headers.get('accept') || '').includes('text/html')
    ) {
      return env.ASSETS.fetch(new URL('/index.html', url.origin));
    }
    return asset;
  },
};
