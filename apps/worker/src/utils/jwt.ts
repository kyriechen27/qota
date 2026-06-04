import { base64UrlDecode, base64UrlEncode, constantTimeEqual, toBytes, fromBytes } from './encoding';
import { HttpError } from './errors';

interface JwtHeader {
  alg: 'HS256';
  typ: 'JWT';
}

async function getKey(secret: string): Promise<CryptoKey> {
  // Fail clearly instead of with an opaque WebCrypto "HMAC key length (0)" error
  // when the secret is missing (e.g. JWT_SECRET not set on Cloudflare).
  if (!secret) {
    throw new HttpError(
      503,
      'jwt_secret_missing',
      'JWT_SECRET 未配置。请设置它：Cloudflare 用 `wrangler pages secret put JWT_SECRET`(或在 Pages 控制台加密钥),本地用根目录 .dev.vars。',
    );
  }
  return crypto.subtle.importKey(
    'raw',
    toBytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signJwt(payload: Record<string, unknown>, secret: string, ttlSeconds: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const header: JwtHeader = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const bodyB64 = base64UrlEncode(JSON.stringify(body));
  const data = `${headerB64}.${bodyB64}`;
  const key = await getKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, toBytes(data));
  return `${data}.${base64UrlEncode(sig)}`;
}

export async function verifyJwt<T = Record<string, unknown>>(token: string, secret: string): Promise<T | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, bodyB64, sigB64] = parts as [string, string, string];
  const data = `${headerB64}.${bodyB64}`;
  const key = await getKey(secret);
  const expectedSig = await crypto.subtle.sign('HMAC', key, toBytes(data));
  const expected = base64UrlEncode(expectedSig);
  if (!constantTimeEqual(expected, sigB64)) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(fromBytes(base64UrlDecode(bodyB64)));
  } catch {
    return null;
  }
  const exp = payload['exp'];
  if (typeof exp === 'number' && exp < Math.floor(Date.now() / 1000)) return null;
  return payload as T;
}
