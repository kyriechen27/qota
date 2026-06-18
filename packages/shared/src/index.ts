export type GlobalRole = 'super_admin' | 'admin' | 'developer' | 'observer';
export type CustomerRole = 'customer_admin' | 'developer' | 'viewer';

// Global role hierarchy (higher number = more privileged).
export const GLOBAL_ROLE_RANK: Record<GlobalRole, number> = {
  observer: 1,
  developer: 2,
  admin: 3,
  super_admin: 4,
};
export const GLOBAL_ROLES: GlobalRole[] = ['super_admin', 'admin', 'developer', 'observer'];

// Roles an operator may assign when switching another user's role.
// The top role (super_admin) may assign its own level and below; any other
// role may assign only roles strictly below its own.
export function assignableGlobalRoles(actorRole: GlobalRole): GlobalRole[] {
  const mine = GLOBAL_ROLE_RANK[actorRole];
  const isTop = mine >= GLOBAL_ROLE_RANK.super_admin;
  return GLOBAL_ROLES.filter((r) => (isTop ? GLOBAL_ROLE_RANK[r] <= mine : GLOBAL_ROLE_RANK[r] < mine));
}

export function canManageGlobalRole(actorRole: GlobalRole, targetRole: GlobalRole): boolean {
  const mine = GLOBAL_ROLE_RANK[actorRole];
  const isTop = mine >= GLOBAL_ROLE_RANK.super_admin;
  return isTop ? GLOBAL_ROLE_RANK[targetRole] <= mine : GLOBAL_ROLE_RANK[targetRole] < mine;
}

export interface User {
  id: number;
  email: string;
  displayName: string | null;
  role: GlobalRole;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Customer {
  id: number;
  code: string;
  name: string;
  description: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Project {
  id: number;
  customerId: number;
  code: string;
  name: string;
  description: string | null;
  defaultChannel: string;
  currentVersion: string | null;
  createdAt: number;
  updatedAt: number;
}

export type VersionStatus = 'pending' | 'ready' | 'archived';

export interface Version {
  id: number;
  projectId: number;
  version: string;
  releaseChannel: string;
  status: VersionStatus;
  r2Key: string;
  filename: string;
  size: number;
  sha256: string | null;
  contentType: string | null;
  notes: string | null;
  isMandatory: boolean;
  isCurrent: boolean;
  minVersion: string | null;
  maxVersion: string | null;
  rolloutPercentage: number;
  deviceGroupId: number | null;
  downloadCount: number;
  /** Random capability slug for token-less public download; null = not public. */
  publicSlug: string | null;
  uploadedBy: number;
  createdAt: number;
  updatedAt: number;
}

/** A version plus its project/customer context — returned by the cross-project
 *  "everything I can access" catalog (GET /api/versions/accessible). */
export interface AccessibleVersion extends Version {
  projectCode: string;
  projectName: string;
  customerId: number;
  customerCode: string;
  customerName: string;
}

export interface Membership {
  id: number;
  userId: number;
  customerId: number;
  role: CustomerRole;
  createdBy: number | null;
  createdAt: number;
}

export interface ProjectMembership {
  id: number;
  userId: number;
  projectId: number;
  role: CustomerRole;
  createdBy: number | null;
  createdAt: number;
}

export type ApiTokenKind = 'device' | 'ci';
export type ApiTokenScope = 'download' | 'upload' | 'full';

export interface ApiToken {
  id: number;
  projectId: number;
  name: string;
  tokenPrefix: string;
  kind: ApiTokenKind;
  scope: ApiTokenScope;
  channel: string | null;
  createdBy: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  lastUsedIp: string | null;
  revokedAt: number | null;
  createdAt: number;
  /** Whether the full token can be re-revealed/copied from the dashboard
   *  (false for tokens issued before encrypted-at-rest storage existed). */
  hasSecret: boolean;
}

export type UploadSessionStatus = 'in_progress' | 'completed' | 'aborted' | 'failed';

export interface UploadSession {
  id: number;
  projectId: number;
  versionId: number | null;
  r2Key: string;
  filename: string;
  totalSize: number;
  partSize: number;
  uploadId: string;
  expectedSha256: string | null;
  releaseChannel: string;
  targetVersion: string;
  contentType: string | null;
  notes: string | null;
  isMandatory: boolean;
  minVersion: string | null;
  maxVersion: string | null;
  rolloutPercentage: number;
  status: UploadSessionStatus;
  initiatedBy: number;
  createdAt: number;
  completedAt: number | null;
}

export interface UploadPart {
  sessionId: number;
  partNumber: number;
  etag: string;
  size: number;
  uploadedAt: number;
}

export interface AuditLog {
  id: number;
  ts: number;
  actorType: 'user' | 'api_token' | 'system';
  actorId: number | null;
  customerId: number | null;
  projectId: number | null;
  action: string;
  targetType: string | null;
  targetId: number | null;
  ip: string | null;
  userAgent: string | null;
  meta: Record<string, unknown> | null;
}

export interface LoginResponse {
  token: string;
  user: User;
}

// === Upload protocol DTOs (matched on worker + web + cli) ===

export interface UploadInitRequest {
  projectId: number;
  filename: string;
  totalSize: number;
  contentType?: string | null;
  /** Target version label, e.g. "1.2.3". */
  version: string;
  releaseChannel?: string;
  notes?: string;
  isMandatory?: boolean;
  minVersion?: string | null;
  maxVersion?: string | null;
  rolloutPercentage?: number;
  /** Replace the existing row when (project, version, releaseChannel) already exists. */
  overwriteExisting?: boolean;
  /** Hex SHA-256, client-computed. Will be re-verified on complete if provided. */
  expectedSha256?: string;
  /** Suggested by client; clamped to [5MB, 64MB] on server. */
  partSizeHint?: number;
}

export interface UploadInitResponse {
  sessionId: number;
  uploadId: string;
  key: string;
  partSize: number;
  partCount: number;
  /** Parts that are already uploaded — clients can skip these on resume. */
  uploadedParts: { partNumber: number; etag: string; size: number }[];
}

export interface UploadSignPartRequest {
  sessionId: number;
  partNumber: number;
}

export interface UploadSignPartResponse {
  url: string;
  expiresAt: number;
}

export interface UploadCompletePart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface UploadCompleteRequest {
  sessionId: number;
  parts: UploadCompletePart[];
  /** Final sha256 of the assembled file. */
  sha256?: string;
}

export interface UploadAbortRequest {
  sessionId: number;
}

export interface DownloadGrantRequest {
  versionId: number;
}

export interface DownloadGrantResponse {
  url: string;
  expiresAt: number;
  filename: string;
  size: number;
  sha256: string | null;
}

export interface ApiError {
  error: string;
  message?: string;
}
