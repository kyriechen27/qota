import type {
  AccessibleVersion,
  ApiToken,
  AuditLog,
  Customer,
  CustomerRole,
  DownloadGrantResponse,
  GlobalRole,
  LoginResponse,
  Membership,
  Project,
  ProjectMembership,
  UploadCompleteRequest,
  UploadInitRequest,
  UploadInitResponse,
  UploadSession,
  UploadSignPartResponse,
  User,
  Version,
} from '@qota/shared';

const TOKEN_KEY = 'qota.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string | null) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let body: { error?: string; message?: string } = {};
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    if (res.status === 401) setToken(null);
    throw new ApiError(res.status, body.error ?? `http_${res.status}`, body.message ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  const ctype = res.headers.get('content-type') ?? '';
  if (!ctype.includes('application/json')) return (await res.text()) as T;
  return (await res.json()) as T;
}

export const api = {
  // Auth
  login: (email: string, password: string) =>
    request<LoginResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  me: () => request<User>('/api/auth/me'),
  changePassword: (oldPassword: string, newPassword: string) =>
    request<{ ok: true }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword, newPassword }),
    }),
  updateProfile: (body: { email?: string; displayName?: string | null }) =>
    request<User>('/api/auth/profile', { method: 'PATCH', body: JSON.stringify(body) }),

  // Users (super_admin)
  listUsers: () => request<User[]>('/api/users'),
  createUser: (body: { email: string; password: string; displayName?: string; role?: GlobalRole }) =>
    request<User>('/api/users', { method: 'POST', body: JSON.stringify(body) }),
  updateUser: (
    id: number,
    body: { displayName?: string | null; role?: GlobalRole; isActive?: boolean; password?: string },
  ) => request<User>(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteUser: (id: number) => request<{ ok: true }>(`/api/users/${id}`, { method: 'DELETE' }),

  // Customers
  listCustomers: () => request<Customer[]>('/api/customers'),
  createCustomer: (body: { code?: string; name: string; description?: string }) =>
    request<Customer>('/api/customers', { method: 'POST', body: JSON.stringify(body) }),
  updateCustomer: (id: number, body: { name?: string; description?: string | null }) =>
    request<Customer>(`/api/customers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteCustomer: (id: number) => request<{ ok: true }>(`/api/customers/${id}`, { method: 'DELETE' }),

  // Projects
  listProjects: (customerId?: number) =>
    request<Project[]>(`/api/projects${customerId ? `?customerId=${customerId}` : ''}`),
  getProject: (id: number) => request<Project>(`/api/projects/${id}`),
  createProject: (body: { customerId: number; code?: string; name: string; description?: string; defaultChannel?: string }) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  updateProject: (id: number, body: { name?: string; description?: string | null; defaultChannel?: string }) =>
    request<Project>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteProject: (id: number) => request<{ ok: true }>(`/api/projects/${id}`, { method: 'DELETE' }),

  // Memberships
  listCustomerMemberships: (customerId: number) =>
    request<(Membership & { scope: 'customer' })[]>(`/api/memberships?customerId=${customerId}`),
  listProjectMemberships: (projectId: number) =>
    request<(ProjectMembership & { scope: 'project' })[]>(`/api/memberships?projectId=${projectId}`),
  listMyMemberships: () =>
    request<(Membership & { scope: 'customer' } | (ProjectMembership & { scope: 'project' }))[]>(
      '/api/memberships',
    ),
  createMembership: (body: {
    userId: number;
    customerId?: number;
    projectId?: number;
    role: CustomerRole;
  }) => request<Membership | ProjectMembership>('/api/memberships', { method: 'POST', body: JSON.stringify(body) }),
  updateMembership: (id: number, scope: 'customer' | 'project', body: { role: CustomerRole }) =>
    request<Membership | ProjectMembership>(`/api/memberships/${id}?scope=${scope}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteMembership: (id: number, scope: 'customer' | 'project') =>
    request<{ ok: true }>(`/api/memberships/${id}?scope=${scope}`, { method: 'DELETE' }),

  // Versions
  // Cross-project catalog of everything the logged-in user may download.
  listAccessibleVersions: (opts?: { includeArchived?: boolean }) =>
    request<AccessibleVersion[]>(`/api/versions/accessible${opts?.includeArchived ? '?includeArchived=1' : ''}`),
  listVersions: (projectId: number, opts?: { includePending?: boolean; channel?: string }) => {
    const qs = new URLSearchParams();
    qs.set('projectId', String(projectId));
    if (opts?.includePending) qs.set('includePending', '1');
    if (opts?.channel) qs.set('channel', opts.channel);
    return request<Version[]>(`/api/versions?${qs}`);
  },
  updateVersion: (
    id: number,
    body: {
      notes?: string | null;
      isMandatory?: boolean;
      minVersion?: string | null;
      maxVersion?: string | null;
      rolloutPercentage?: number;
      status?: 'ready' | 'archived';
    },
  ) => request<Version>(`/api/versions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteVersion: (id: number) => request<{ ok: true }>(`/api/versions/${id}`, { method: 'DELETE' }),
  // Public, token-less download link (capability slug). Enable is idempotent.
  enableVersionPublic: (id: number) =>
    request<{ publicSlug: string }>(`/api/versions/${id}/public`, { method: 'POST' }),
  disableVersionPublic: (id: number) =>
    request<{ ok: true }>(`/api/versions/${id}/public`, { method: 'DELETE' }),

  // Upload (multipart S3)
  uploadInit: (body: UploadInitRequest) =>
    request<UploadInitResponse>('/api/upload/init', { method: 'POST', body: JSON.stringify(body) }),
  uploadSignPart: (sessionId: number, partNumber: number) =>
    request<UploadSignPartResponse>('/api/upload/sign-part', {
      method: 'POST',
      body: JSON.stringify({ sessionId, partNumber }),
    }),
  uploadComplete: (body: UploadCompleteRequest) =>
    request<Version>('/api/upload/complete', { method: 'POST', body: JSON.stringify(body) }),
  uploadAbort: (sessionId: number) =>
    request<{ ok: true }>('/api/upload/abort', { method: 'POST', body: JSON.stringify({ sessionId }) }),
  listUploadSessions: (projectId: number, status?: UploadSession['status']) => {
    const qs = new URLSearchParams({ projectId: String(projectId) });
    if (status) qs.set('status', status);
    return request<UploadSession[]>(`/api/upload/sessions?${qs}`);
  },
  getUploadSession: (id: number) =>
    request<UploadSession & { uploadedParts: { partNumber: number; etag: string; size: number; uploadedAt: number }[] }>(
      `/api/upload/sessions/${id}`,
    ),

  // Download
  grantDownload: (versionId: number) =>
    request<DownloadGrantResponse>('/api/download/grant', {
      method: 'POST',
      body: JSON.stringify({ versionId }),
    }),

  // API tokens (devices + ci)
  listApiTokens: (projectId: number) =>
    request<ApiToken[]>(`/api/api-tokens?projectId=${projectId}`),
  createApiToken: (body: {
    projectId: number;
    name: string;
    kind?: 'device' | 'ci';
    scope?: 'download' | 'upload' | 'full';
    channel?: string;
    expiresAt?: number | null;
  }) =>
    request<ApiToken & { token: string }>('/api/api-tokens', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  revokeApiToken: (id: number) =>
    request<{ ok: true }>(`/api/api-tokens/${id}/revoke`, { method: 'POST' }),
  deleteApiToken: (id: number) =>
    request<{ ok: true }>(`/api/api-tokens/${id}`, { method: 'DELETE' }),
  revealApiToken: (id: number) =>
    request<{ token: string }>(`/api/api-tokens/${id}/reveal`),

  // Audit
  listAudit: (opts?: { customerId?: number; projectId?: number; action?: string; before?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.customerId) qs.set('customerId', String(opts.customerId));
    if (opts?.projectId) qs.set('projectId', String(opts.projectId));
    if (opts?.action) qs.set('action', opts.action);
    if (opts?.before) qs.set('before', String(opts.before));
    if (opts?.limit) qs.set('limit', String(opts.limit));
    return request<AuditLog[]>(`/api/audit?${qs}`);
  },
};
