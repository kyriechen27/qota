import { base64UrlDecode, base64UrlEncode, constantTimeEqual, toBytes } from './encoding';

const ITERATIONS = 100_000;
const KEYLEN = 32;
const SALT_LEN = 16;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    toBytes(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    KEYLEN * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${base64UrlEncode(salt)}$${base64UrlEncode(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  const salt = base64UrlDecode(parts[2]!);
  const expected = parts[3]!;
  if (!Number.isFinite(iterations) || iterations < 1000) return false;
  const got = base64UrlEncode(await pbkdf2(password, salt, iterations));
  return constantTimeEqual(got, expected);
}
