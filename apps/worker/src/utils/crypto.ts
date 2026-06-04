// Symmetric encryption for secrets stored at rest (currently: API tokens, so
// they can be re-copied from the dashboard). AES-256-GCM with a key derived from
// JWT_SECRET via SHA-256 — a D1 dump alone can't reveal the secrets without the
// key (which lives separately, as a Pages secret / env var). Works on both the
// Workers and Node runtimes (Web Crypto).

import { base64UrlDecode, base64UrlEncode, fromBytes, toBytes } from './encoding';

async function aesKey(secret: string): Promise<CryptoKey> {
  const keyBytes = await crypto.subtle.digest('SHA-256', toBytes(secret));
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypt `plaintext` with AES-256-GCM. Returns base64url(iv[12] || ciphertext+tag). */
export async function encryptSecret(plaintext: string, secret: string): Promise<string> {
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, toBytes(plaintext));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return base64UrlEncode(out);
}

/** Reverse of encryptSecret. Returns null on any failure (wrong key / corrupt / tampered). */
export async function decryptSecret(enc: string, secret: string): Promise<string | null> {
  try {
    const raw = base64UrlDecode(enc);
    const iv = raw.slice(0, 12);
    const ct = raw.slice(12);
    const key = await aesKey(secret);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return fromBytes(pt);
  } catch {
    return null;
  }
}
