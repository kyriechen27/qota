import type { ApiTokenRestrictions } from '@qota/shared';
import { badRequest, forbidden } from '../utils/errors';
import { normalizeSpecialVersion } from './version-notes';

type RestrictionInput = { channel?: unknown; specialVersion?: unknown; version?: unknown; versionId?: unknown };

function optionalLabel(value: unknown, field: string, pattern: RegExp): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !pattern.test(value)) throw badRequest(`invalid ${field}`);
  return value;
}

export function normalizeTokenRestrictions(input: RestrictionInput): ApiTokenRestrictions {
  const versionId = input.versionId ?? null;
  if (versionId !== null && (typeof versionId !== 'number' || !Number.isSafeInteger(versionId) || versionId <= 0)) {
    throw badRequest('versionId must be a positive integer');
  }
  return {
    channel: optionalLabel(input.channel, 'channel', /^[a-z0-9][a-z0-9_-]{0,31}$/),
    specialVersion: normalizeSpecialVersion(input.specialVersion) ?? null,
    version: optionalLabel(input.version, 'version', /^[A-Za-z0-9._+-]{1,64}$/),
    versionId,
  };
}

export function hasVersionRestrictions(restrictions: ApiTokenRestrictions): boolean {
  return restrictions.specialVersion !== null || restrictions.version !== null || restrictions.versionId !== null;
}

/** Queries can only narrow a token. The stored restriction is never replaced. */
export function downloadRestrictions(token: ApiTokenRestrictions, query: Record<string, string | undefined>, latest = false): ApiTokenRestrictions {
  let versionId: number | undefined;
  if (query.versionId !== undefined) {
    if (!/^\d+$/.test(query.versionId)) throw badRequest('invalid versionId');
    versionId = Number(query.versionId);
  }
  const requested = normalizeTokenRestrictions({ ...query, versionId });
  const result = { ...token };
  for (const key of ['channel', 'specialVersion', 'version', 'versionId'] as const) {
    const restriction = token[key];
    const request = requested[key];
    if (restriction !== null && request !== null && restriction !== request) {
      throw forbidden(`${key} not allowed for this token`);
    }
  }
  result.channel = token.channel || requested.channel;
  result.specialVersion = token.specialVersion ?? requested.specialVersion;
  result.version = token.version ?? requested.version;
  result.versionId = token.versionId ?? requested.versionId;
  // Keep the old latest endpoint's default, while allowing a token pinned to
  // a flash/ota file or label to resolve without an unrelated stable filter.
  if (latest && !result.channel && !hasVersionRestrictions(token)) result.channel = 'stable';
  return result;
}

/** All artifact queries using this filter must alias the versions table as v. */
export function tokenVersionFilter(projectId: number, restrictions: ApiTokenRestrictions) {
  const where = ['v.project_id = ?'];
  const args: (string | number)[] = [projectId];
  if (restrictions.channel) {
    where.push('v.release_channel = ?');
    args.push(restrictions.channel);
  }
  if (restrictions.specialVersion !== null) {
    where.push(`EXISTS (SELECT 1 FROM version_metadata tm
      WHERE tm.project_id = v.project_id AND tm.version = v.version AND tm.special_version = ?)`);
    args.push(restrictions.specialVersion);
  }
  if (restrictions.version !== null) {
    where.push('v.version = ?');
    args.push(restrictions.version);
  }
  if (restrictions.versionId !== null) {
    where.push('v.id = ?');
    args.push(restrictions.versionId);
  }
  return { sql: where.join(' AND '), args };
}
