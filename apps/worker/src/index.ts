import { Hono } from 'hono';
import type { AppEnv } from './env';
import { HttpError } from './utils/errors';
import { authRoutes } from './routes/auth';
import { userRoutes } from './routes/users';
import { customerRoutes } from './routes/customers';
import { projectRoutes } from './routes/projects';
import { membershipRoutes } from './routes/memberships';
import { versionRoutes } from './routes/versions';
import { downloadRoutes } from './routes/download';
import { apiTokenRoutes } from './routes/api-tokens';
import { uploadRoutes } from './routes/upload';
import { storageRoutes } from './routes/storage';
import { auditRoutes } from './routes/audit';
import { ensureAdminSeed } from './lib/bootstrap';

const app = new Hono<AppEnv>();

// CORS — allow-list driven, supports credentials-less Bearer flow
app.use('*', async (c, next) => {
  const origin = c.req.header('Origin') ?? '';
  const allowed = (c.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const allow = allowed.includes(origin) || allowed.includes('*');
  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': allow ? origin || '*' : '',
        'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
        'access-control-allow-headers': 'authorization,content-type',
        'access-control-max-age': '86400',
      },
    });
  }
  await next();
  if (allow && origin) c.res.headers.set('access-control-allow-origin', origin);
  c.res.headers.set('vary', 'origin');
});

// First-run admin seed (idempotent; a no-op once any user exists). Runs on real
// requests only — the CORS handler above returns early for OPTIONS preflight.
app.use('*', async (c, next) => {
  await ensureAdminSeed(c.env);
  await next();
});

app.get('/api/health', (c) => c.json({ ok: true, time: Date.now(), service: 'qota-api' }));

app.route('/api/auth', authRoutes);
app.route('/api/users', userRoutes);
app.route('/api/customers', customerRoutes);
app.route('/api/projects', projectRoutes);
app.route('/api/memberships', membershipRoutes);
app.route('/api/versions', versionRoutes);
app.route('/api/upload', uploadRoutes);
app.route('/api/storage', storageRoutes);
app.route('/api/download', downloadRoutes);
app.route('/api/api-tokens', apiTokenRoutes);
app.route('/api/audit', auditRoutes);

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.code, message: err.message }, err.status);
  }
  console.error('unhandled error', err);
  return c.json({ error: 'internal', message: 'internal server error' }, 500);
});

app.notFound((c) => c.json({ error: 'not_found' }, 404));

export default app;
