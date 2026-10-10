import type { D1Database } from '@cloudflare/workers-types';
import { badRequest, HttpError } from '../utils/errors';

export async function registrationEnabled(db: D1Database): Promise<boolean> {
  const row = await db.prepare('SELECT enabled FROM registration_settings WHERE id = 1')
    .first<{ enabled: number }>();
  return row?.enabled === 1;
}

export function registrationDisabled() {
  return new HttpError(403, 'registration_disabled', 'registration is disabled');
}

export function registrationEmail(value: unknown): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw badRequest('invalid email');
  const email = value.trim().toLowerCase();
  const parts = email.split('@');
  const local = parts[0] ?? '';
  const domain = parts[1] ?? '';
  if (email.length > 254 || parts.length !== 2 || !local || local.length > 64 ||
      !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
      local.startsWith('.') || local.endsWith('.') || local.includes('..') ||
      !domain.includes('.') || !domain.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) {
    throw badRequest('invalid email');
  }
  return email;
}
