import { bytesToHex, toBytes } from './encoding';

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const buf = typeof data === 'string' ? toBytes(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return bytesToHex(digest);
}
