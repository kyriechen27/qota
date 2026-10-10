import type { MailSettings, MailSettingsInput, MailStatus } from '@qota/shared';
import type { Bindings } from '../env';
import type { SMTPConfig } from './smtp';
import { decryptSecret, encryptSecret } from '../utils/crypto';
import { badRequest, HttpError } from '../utils/errors';

interface MailSettingsRow {
  enabled: number;
  host: string;
  port: number;
  security: 'tls' | 'starttls';
  username: string;
  password_enc: string | null;
  from_email: string;
  from_name: string;
}

const DEFAULT_SETTINGS: MailSettings = {
  enabled: false, host: '', port: 465, security: 'tls', username: '', fromEmail: '', fromName: '', hasPassword: false,
};
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function headerText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value) || value.length > maximum) {
    throw badRequest(`invalid ${field}`);
  }
  return value.trim();
}

function smtpHost(value: unknown): string {
  const host = headerText(value, 'host', 253).toLowerCase();
  if (!host) return host;
  if (host.includes(':')) {
    // A bare IPv6 address is a host; a URL or a host:port pair is not.
    if (!/^[0-9a-f:.]+$/.test(host)) throw badRequest('invalid host');
    try { new URL(`http://[${host}]/`); } catch { throw badRequest('invalid host'); }
    return host;
  }
  if (!host.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) {
    throw badRequest('invalid host');
  }
  return host;
}

export function mailAddress(value: unknown): string {
  const address = headerText(value, 'email address', 254);
  const parts = address.split('@');
  const local = parts[0] ?? '';
  const domain = parts[1] ?? '';
  if (parts.length !== 2 || !local || local.length > 64 ||
      !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
      local.startsWith('.') || local.endsWith('.') || local.includes('..') ||
      !domain || !domain.split('.').every((part) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part))) {
    throw badRequest('invalid email address');
  }
  return address;
}

function validateSettings(value: unknown): MailSettingsInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('mail settings required');
  const body = value as Record<string, unknown>;
  if (typeof body.enabled !== 'boolean') throw badRequest('enabled must be a boolean');
  if (typeof body.port !== 'number' || !Number.isSafeInteger(body.port) || body.port < 1 || body.port > 65535 || body.port === 25) {
    throw badRequest('port must be 1-65535 except 25; use 465 or 587 when possible');
  }
  if (body.security !== 'tls' && body.security !== 'starttls') throw badRequest('security must be tls or starttls');
  if (body.password !== undefined && (typeof body.password !== 'string' || body.password.length > 4096 || CONTROL_CHARACTERS.test(body.password))) {
    throw badRequest('invalid password');
  }
  const fromEmail = headerText(body.fromEmail, 'fromEmail', 254);
  return {
    enabled: body.enabled, host: smtpHost(body.host), port: body.port, security: body.security,
    username: headerText(body.username, 'username', 320), fromEmail: fromEmail ? mailAddress(fromEmail) : '',
    fromName: headerText(body.fromName, 'fromName', 200),
    ...(body.password === undefined ? {} : { password: body.password as string }),
  };
}

async function storedSettings(env: Bindings) {
  return env.DB.prepare('SELECT enabled, host, port, security, username, password_enc, from_email, from_name FROM mail_settings WHERE id = 1')
    .first<MailSettingsRow>();
}

function settingsDto(row: MailSettingsRow | null): MailSettings {
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    enabled: !!row.enabled, host: row.host, port: row.port, security: row.security, username: row.username,
    fromEmail: row.from_email, fromName: row.from_name, hasPassword: !!row.password_enc,
  };
}

async function configFromRow(row: MailSettingsRow | null, secret: string): Promise<SMTPConfig> {
  try {
    if (!row) throw new Error();
    const fields = validateSettings(settingsDto(row));
    const password = row.password_enc ? await decryptSecret(row.password_enc, secret) : null;
    if (!fields.host || !fields.username || !fields.fromEmail || !password || CONTROL_CHARACTERS.test(password)) throw new Error();
    return {
      host: fields.host, port: fields.port, security: fields.security, username: fields.username,
      password, fromEmail: fields.fromEmail, fromName: fields.fromName,
    };
  } catch {
    throw new HttpError(400, 'mail_not_configured', 'mail settings are incomplete; ask an administrator to configure them');
  }
}

export async function getMailSettings(env: Bindings): Promise<MailSettings> {
  return settingsDto(await storedSettings(env));
}

export async function getMailStatus(env: Bindings): Promise<MailStatus> {
  const row = await storedSettings(env);
  let configured = false;
  try { await configFromRow(row, env.JWT_SECRET); configured = true; } catch { /* Only expose readiness. */ }
  return { enabled: !!row?.enabled, configured };
}

export async function getMailConfig(env: Bindings, options: { requireEnabled?: boolean } = {}): Promise<SMTPConfig> {
  const row = await storedSettings(env);
  if ((options.requireEnabled ?? true) && !row?.enabled) {
    throw new HttpError(400, 'mail_disabled', 'mail notifications are disabled');
  }
  return configFromRow(row, env.JWT_SECRET);
}

export async function saveMailSettings(env: Bindings, userId: number, body: unknown): Promise<MailSettings> {
  const fields = validateSettings(body);
  const existing = await storedSettings(env);
  const passwordEnc = fields.password === undefined ? existing?.password_enc ?? null
    : fields.password ? await encryptSecret(fields.password, env.JWT_SECRET) : null;
  const candidate: MailSettingsRow = {
    enabled: fields.enabled ? 1 : 0, host: fields.host, port: fields.port, security: fields.security,
    username: fields.username, password_enc: passwordEnc, from_email: fields.fromEmail, from_name: fields.fromName,
  };
  if (fields.enabled) await configFromRow(candidate, env.JWT_SECRET);
  await env.DB.prepare(
    `INSERT INTO mail_settings (id, enabled, host, port, security, username, password_enc, from_email, from_name, updated_by, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, host = excluded.host, port = excluded.port,
       security = excluded.security, username = excluded.username,
       password_enc = CASE WHEN ? = 1 THEN excluded.password_enc ELSE mail_settings.password_enc END,
       from_email = excluded.from_email, from_name = excluded.from_name, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(candidate.enabled, candidate.host, candidate.port, candidate.security, candidate.username, candidate.password_enc,
    candidate.from_email, candidate.from_name, userId, Date.now(), fields.password === undefined ? 0 : 1).run();
  return getMailSettings(env);
}
