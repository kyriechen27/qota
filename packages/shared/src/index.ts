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
  /** Organizational parent only; customer permissions do not inherit. */
  parentId: number | null;
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
  currentVersions: string[];
  /** Latest current label, retained for older clients. Prefer currentVersions. */
  currentVersion: string | null;
  createdAt: number;
  updatedAt: number;
}

export type VersionStatus = 'pending' | 'ready' | 'archived';

export interface Announcement {
  id: number;
  projectId: number;
  projectName: string;
  customerName: string;
  /** Uploaded version label, retained if its files are later removed. */
  version: string | null;
  content: string;
  authorId: number;
  authorName: string;
  createdAt: number;
  updatedAt: number;
  canEdit: boolean;
  canDelete: boolean;
  mail: AnnouncementMailSummary;
}

export interface AnnouncementMailSummary {
  total: number;
  sent: number;
  failed: number;
  pending: number;
  skipped: number;
}

export interface AnnouncementRecipient {
  id: number;
  email: string;
  displayName: string | null;
}

export interface AnnouncementListResponse {
  items: Announcement[];
  nextCursor: string | null;
  publishableProjects: { id: number; name: string; customerName: string }[];
}

export interface UploadAnnouncement {
  /** One UUID shared by all files and retries of the same upload batch. */
  batchKey: string;
  content: string;
  /** Active users who can view this project; omit or use [] for no email. */
  recipientIds?: number[];
}

export interface MailSettings {
  enabled: boolean;
  host: string;
  port: number;
  security: 'tls' | 'starttls';
  username: string;
  fromEmail: string;
  fromName: string;
  hasPassword: boolean;
}

export type MailSettingsInput = Omit<MailSettings, 'hasPassword'> & {
  /** Omit to retain the saved password. An explicit empty string clears it. */
  password?: string;
};

export interface MailStatus {
  enabled: boolean;
  configured: boolean;
}

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
  /** Notes shared by this version label, independent of its file notes. */
  versionNotes: string | null;
  /** Optional version-level text; shares version-note edit permissions. */
  specialVersion: string | null;
  canEditVersionNotes?: boolean;
  /** Notes belonging only to this file. */
  notes: string | null;
  /** Authenticated caller may edit notes; false while this label is current. */
  canEditNotes?: boolean;
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

/** Non-null conditions are combined with AND within the token's project. */
export interface ApiTokenRestrictions {
  channel: string | null;
  specialVersion: string | null;
  version: string | null;
  /** One firmware file id; deleting it never broadens the token's access. */
  versionId: number | null;
}

export interface ApiToken extends ApiTokenRestrictions {
  id: number;
  projectId: number;
  name: string;
  tokenPrefix: string;
  kind: ApiTokenKind;
  scope: ApiTokenScope;
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
  announcement?: UploadAnnouncement;
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
  /** Notes belonging only to this file. */
  notes?: string | null;
  /** Shared version notes. Omit to preserve; null clears the existing value. */
  versionNotes?: string | null;
  /** Single-line version metadata, max 128 chars. Omit to preserve; null clears. */
  specialVersion?: string | null;
  /** Publish once when the first file in this batch completes successfully. */
  announcement?: UploadAnnouncement;
  isMandatory?: boolean;
  minVersion?: string | null;
  maxVersion?: string | null;
  rolloutPercentage?: number;
  /** Replace only the matching (project, version, releaseChannel, filename) file. */
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
