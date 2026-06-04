import type { D1Database } from '@cloudflare/workers-types';
import { pinyin } from 'pinyin-pro';

/**
 * Turn an arbitrary display name into a code-safe slug. Chinese characters are
 * romanized to pinyin (no tones) so names stay meaningful:
 *   "Acme Corp"   → "acme-corp"
 *   "利尔星"       → "lierxing"
 *   "金鹏 Tech"    → "jinpeng-tech"
 *   "深圳分部"     → "shenzhenfenbu"
 * Result matches /^[a-z0-9][a-z0-9_-]{0,63}$/ when non-empty; empty only when
 * the name has no romanizable characters at all (caller then falls back).
 */
export function slugify(input: string): string {
  // pinyin-pro leaves non-Chinese text untouched; `nonZh: 'consecutive'` keeps
  // runs of latin/digits together so we don't shatter "Tech" into letters.
  const romanized = pinyin(input, {
    toneType: 'none',
    separator: '',
    nonZh: 'consecutive',
    type: 'string',
  });
  return romanized
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-') // non-alphanumeric → hyphen
    .replace(/^-+|-+$/g, '')      // strip leading/trailing hyphens
    .slice(0, 48);
}

/**
 * Generate a code that is unique within a scope, deriving from `name` when the
 * caller didn't supply one. `isTaken` decides uniqueness (lets callers scope to
 * a customer for projects, or globally for customers). When the name slugifies
 * to nothing (e.g. all-CJK names), falls back to `fallbackPrefix` + a counter.
 */
export async function generateUniqueCode(
  name: string,
  fallbackPrefix: string,
  isTaken: (code: string) => Promise<boolean>,
): Promise<string> {
  const base = slugify(name) || fallbackPrefix;
  if (!(await isTaken(base))) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`.slice(0, 64);
    if (!(await isTaken(candidate))) return candidate;
  }
  // Extremely unlikely; use a time-independent random-ish suffix from crypto.
  const rand = [...crypto.getRandomValues(new Uint8Array(4))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${fallbackPrefix}-${rand}`;
}

export async function customerCodeTaken(db: D1Database, code: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM customers WHERE code = ?').bind(code).first();
  return !!row;
}

export async function projectCodeTaken(db: D1Database, customerId: number, code: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM projects WHERE customer_id = ? AND code = ?')
    .bind(customerId, code)
    .first();
  return !!row;
}
