import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'zh' | 'en';

const LANG_KEY = 'qota.lang';

type Dict = Record<string, string>;

const zh: Dict = {
  // common
  'common.cancel': '取消',
  'common.create': '创建',
  'common.close': '关闭',
  'common.delete': '删除',
  'common.revoke': '吊销',
  'common.done': '完成',
  'common.loading': '加载中…',
  'common.select': '请选择…',
  'common.save': '保存',

  // enums — roles
  'role.super_admin': '超级管理员',
  'role.developer': '开发者',
  'role.viewer': '查看者',
  'role.customer_admin': '客户管理员',
  // enums — token kind / scope
  'kind.device': '设备',
  'kind.ci': 'CI',
  'scope.download': '下载',
  'scope.upload': '上传',
  'scope.full': '全部',
  // enums — version status
  'status.ready': '就绪',
  'status.archived': '已归档',
  'status.pending': '待上传',
  // enums — membership scope
  'mscope.customer': '客户',
  'mscope.project': '项目',

  // nav
  'nav.dashboard': '仪表盘',
  'nav.customers': '客户',
  'nav.projects': '项目',
  'nav.users': '用户',
  'nav.memberships': '成员授权',
  'nav.account': '账户',
  'nav.signout': '退出登录',

  // login
  'login.subtitle': 'OTA 版本管理平台',
  'login.email': '邮箱',
  'login.password': '密码',
  'login.signin': '登录',
  'login.signingin': '登录中…',
  'login.failed': '登录失败',

  // dashboard
  'dashboard.title': '仪表盘',
  'dashboard.overview': '概览',
  'dashboard.access': '你可以访问 {customers} 个客户、{projects} 个项目。',
  'dashboard.recent': '最近项目',
  'dashboard.noProjects': '暂无可见项目。',
  'dashboard.loadFailed': '加载失败',

  // customers
  'customers.title': '客户',
  'customers.new': '+ 新建客户',
  'customers.colCode': '代号',
  'customers.colName': '名称',
  'customers.colDesc': '描述',
  'customers.colCreated': '创建时间',
  'customers.empty': '暂无可见客户。',
  'customers.confirmDelete': '删除该客户及其下所有项目/版本?',
  'customers.dlgNew': '新建客户',
  'customers.fldCode': '代号(可选,R2 路径段)',
  'customers.fldName': '名称',
  'customers.fldDesc': '描述',

  // projects
  'projects.title': '项目',
  'projects.allCustomers': '全部客户',
  'projects.new': '+ 新建项目',
  'projects.colCustomer': '客户',
  'projects.colCode': '代号',
  'projects.colName': '名称',
  'projects.colDesc': '描述',
  'projects.empty': '暂无可见项目。',
  'projects.confirmDelete': '删除该项目及其所有版本?',
  'projects.dlgNew': '新建项目',
  'projects.fldCustomer': '客户',
  'projects.fldCode': '代号(可选)',
  'projects.fldName': '名称',
  'projects.fldDesc': '描述',

  // users
  'users.title': '用户',
  'users.new': '+ 新建用户',
  'users.colId': 'ID',
  'users.colEmail': '邮箱',
  'users.colName': '姓名',
  'users.colRole': '角色',
  'users.colStatus': '状态',
  'users.active': '启用',
  'users.disabled': '停用',
  'users.disable': '停用',
  'users.enable': '启用',
  'users.toggleRole': '切换角色',
  'users.resetPw': '重置密码',
  'users.confirmRole': '将 {email} 改为 {role}?',
  'users.promptPw': '为 {email} 设置新密码(≥8 位):',
  'users.pwUpdated': '密码已更新。',
  'users.confirmDelete': '删除 {email}?',
  'users.lastSuperAdmin': '系统必须保留一个超级管理员',
  'users.dlgNew': '新建用户',
  'users.fldEmail': '邮箱',
  'users.fldPassword': '密码(≥8 位)',
  'users.fldName': '显示名',
  'users.fldRole': '角色',

  // project detail
  'pd.project': '项目',
  'pd.versions': '版本',
  'pd.uploadNew': '+ 上传新版本',
  'pd.colVersion': '版本号',
  'pd.colChannel': '通道',
  'pd.colStatus': '状态',
  'pd.colSize': '大小',
  'pd.colSha': 'SHA-256',
  'pd.colMandatory': '强制',
  'pd.colUploaded': '上传时间',
  'pd.colDownloads': '下载次数',
  'pd.download': '下载',
  'pd.archive': '归档',
  'pd.restore': '恢复',
  'pd.noVersions': '暂无版本。',
  'pd.confirmDeleteVer': '删除 {version}({channel})?',
  'pd.apiTokens': 'API 令牌',
  'pd.issueToken': '+ 签发令牌',
  'pd.tokensHint': '设备通过 /api/download/device/* 拉取;CI 通过 scripts/upload.mjs 上传。',
  'pd.colName': '名称',
  'pd.colKind': '类型',
  'pd.colScope': '权限',
  'pd.colPrefix': '前缀',
  'pd.colLastUsed': '最近使用',
  'pd.tokenChannelAny': '(任意)',
  'pd.channelNew': '+ 新建通道…',
  'pd.channelBack': '← 选择已有通道',
  'pd.noTokens': '暂无 API 令牌。',
  'pd.revoked': '已吊销',
  'pd.tokenActive': '有效',
  'pd.confirmRevoke': '吊销令牌「{name}」?',
  'pd.dlgUpload': '上传新 OTA 版本',
  'pd.fldFile': '文件',
  'pd.fldVersion': '版本号(如 1.2.3)',
  'pd.fldChannel': '通道',
  'pd.fldMandatory': '标记为强制升级',
  'pd.fldNotes': '备注',
  'pd.hashing': '本地计算哈希中…',
  'pd.uploadingR2': '上传到 R2 中…',
  'pd.cancelUpload': '取消上传',
  'pd.startUpload': '开始上传',
  'pd.dlgIssueToken': '签发 API 令牌',
  'pd.tokenIssuedPre': '令牌已生成——请立即复制,它',
  'pd.notShownAgain': '不会再次显示',
  'pd.copyToken': '复制令牌',
  'pd.copied': '已复制 ✓',
  'pd.fldTokenName': '名称(便于记录)',
  'pd.fldKind': '类型',
  'pd.kindDevice': 'device(仅下载)',
  'pd.kindCi': 'ci(上传/下载)',
  'pd.fldTokenScope': '权限范围',
  'pd.scopeUploadOnly': '仅上传',
  'pd.scopeDownloadOnly': '仅下载',
  'pd.scopeFullOpt': '全部',
  'pd.fldRestrictChannel': '限定通道(可选)',
  'pd.issue': '签发',

  // memberships
  'mem.title': '成员授权',
  'mem.allCustomers': '全部客户',
  'mem.projectFilter': '— 按项目筛选 —',
  'mem.grant': '+ 授予成员',
  'mem.rolesHint':
    '角色:客户管理员(管理整个客户/项目)、开发者(上传 + 下载)、查看者(仅下载)。超级管理员无视成员关系,可见全部。',
  'mem.colUser': '用户',
  'mem.colScope': '范围',
  'mem.colTarget': '目标',
  'mem.colRole': '角色',
  'mem.colCreated': '创建时间',
  'mem.empty': '当前视图无成员。',
  'mem.confirmRevoke': '吊销该成员授权?',
  'mem.dlgGrant': '授予成员',
  'mem.fldUser': '用户',
  'mem.fldScope': '范围',
  'mem.scopeCustomer': 'customer(对其所有项目生效)',
  'mem.scopeProject': 'project(覆盖)',
  'mem.fldTarget': '目标',
  'mem.fldRole': '角色',

  // account
  'account.title': '账户',
  'account.profile': '个人信息',
  'account.email': '邮箱',
  'account.role': '角色',
  'account.displayName': '显示名',
  'account.saveProfile': '保存资料',
  'account.profileSavedRelogin': '资料已更新，请重新登录…',
  'account.changePw': '修改密码',
  'account.currentPw': '当前密码',
  'account.newPw': '新密码(≥8 位)',
  'account.confirmPw': '确认密码',
  'account.pwMismatch': '两次输入的密码不一致',
  'account.pwUpdated': '密码已更新。',
  'account.update': '更新密码',
  'account.updating': '更新中…',
  'account.failed': '失败',
};

const en: Dict = {
  'common.cancel': 'Cancel',
  'common.create': 'Create',
  'common.close': 'Close',
  'common.delete': 'Delete',
  'common.revoke': 'Revoke',
  'common.done': 'Done',
  'common.loading': 'Loading…',
  'common.select': 'Select…',
  'common.save': 'Save',

  'role.super_admin': 'super_admin',
  'role.developer': 'developer',
  'role.viewer': 'viewer',
  'role.customer_admin': 'customer_admin',
  'kind.device': 'device',
  'kind.ci': 'ci',
  'scope.download': 'download',
  'scope.upload': 'upload',
  'scope.full': 'full',
  'status.ready': 'ready',
  'status.archived': 'archived',
  'status.pending': 'pending',
  'mscope.customer': 'customer',
  'mscope.project': 'project',

  'nav.dashboard': 'Dashboard',
  'nav.customers': 'Customers',
  'nav.projects': 'Projects',
  'nav.users': 'Users',
  'nav.memberships': 'Memberships',
  'nav.account': 'Account',
  'nav.signout': 'Sign out',

  'login.subtitle': 'OTA Version Manager',
  'login.email': 'Email',
  'login.password': 'Password',
  'login.signin': 'Sign in',
  'login.signingin': 'Signing in…',
  'login.failed': 'login failed',

  'dashboard.title': 'Dashboard',
  'dashboard.overview': 'Overview',
  'dashboard.access': 'You can access {customers} customer(s) and {projects} project(s).',
  'dashboard.recent': 'Recent projects',
  'dashboard.noProjects': 'No projects visible.',
  'dashboard.loadFailed': 'failed to load',

  'customers.title': 'Customers',
  'customers.new': '+ New customer',
  'customers.colCode': 'Code',
  'customers.colName': 'Name',
  'customers.colDesc': 'Description',
  'customers.colCreated': 'Created',
  'customers.empty': 'No customers visible.',
  'customers.confirmDelete': 'Delete this customer and ALL its projects/versions?',
  'customers.dlgNew': 'New customer',
  'customers.fldCode': 'Code (optional, R2 path segment)',
  'customers.fldName': 'Name',
  'customers.fldDesc': 'Description',

  'projects.title': 'Projects',
  'projects.allCustomers': 'All customers',
  'projects.new': '+ New project',
  'projects.colCustomer': 'Customer',
  'projects.colCode': 'Code',
  'projects.colName': 'Name',
  'projects.colDesc': 'Description',
  'projects.empty': 'No projects visible.',
  'projects.confirmDelete': 'Delete this project and all its versions?',
  'projects.dlgNew': 'New project',
  'projects.fldCustomer': 'Customer',
  'projects.fldCode': 'Code (optional)',
  'projects.fldName': 'Name',
  'projects.fldDesc': 'Description',

  'users.title': 'Users',
  'users.new': '+ New user',
  'users.colId': 'ID',
  'users.colEmail': 'Email',
  'users.colName': 'Name',
  'users.colRole': 'Role',
  'users.colStatus': 'Status',
  'users.active': 'active',
  'users.disabled': 'disabled',
  'users.disable': 'Disable',
  'users.enable': 'Enable',
  'users.toggleRole': 'Toggle role',
  'users.resetPw': 'Reset pw',
  'users.confirmRole': 'Change {email} to {role}?',
  'users.promptPw': 'New password for {email} (>=8 chars):',
  'users.pwUpdated': 'Password updated.',
  'users.confirmDelete': 'Delete {email}?',
  'users.lastSuperAdmin': 'The system must keep at least one super admin',
  'users.dlgNew': 'New user',
  'users.fldEmail': 'Email',
  'users.fldPassword': 'Password (>=8 chars)',
  'users.fldName': 'Display name',
  'users.fldRole': 'Role',

  'pd.project': 'Project',
  'pd.versions': 'Versions',
  'pd.uploadNew': '+ Upload new version',
  'pd.colVersion': 'Version',
  'pd.colChannel': 'Channel',
  'pd.colStatus': 'Status',
  'pd.colSize': 'Size',
  'pd.colSha': 'SHA-256',
  'pd.colMandatory': 'Mandatory',
  'pd.colUploaded': 'Uploaded',
  'pd.colDownloads': 'Downloads',
  'pd.download': 'Download',
  'pd.archive': 'Archive',
  'pd.restore': 'Restore',
  'pd.noVersions': 'No versions yet.',
  'pd.confirmDeleteVer': 'Delete {version} ({channel})?',
  'pd.apiTokens': 'API tokens',
  'pd.issueToken': '+ Issue token',
  'pd.tokensHint': 'Devices use /api/download/device/*; CI uploads via scripts/upload.mjs.',
  'pd.colName': 'Name',
  'pd.colKind': 'Kind',
  'pd.colScope': 'Scope',
  'pd.colPrefix': 'Prefix',
  'pd.colLastUsed': 'Last used',
  'pd.tokenChannelAny': '(any)',
  'pd.channelNew': '+ New channel…',
  'pd.channelBack': '← Pick existing',
  'pd.noTokens': 'No API tokens yet.',
  'pd.revoked': 'revoked',
  'pd.tokenActive': 'active',
  'pd.confirmRevoke': 'Revoke token "{name}"?',
  'pd.dlgUpload': 'Upload new OTA version',
  'pd.fldFile': 'File',
  'pd.fldVersion': 'Version (e.g. 1.2.3)',
  'pd.fldChannel': 'Channel',
  'pd.fldMandatory': 'Mark as mandatory upgrade',
  'pd.fldNotes': 'Notes',
  'pd.hashing': 'Hashing locally…',
  'pd.uploadingR2': 'Uploading to R2…',
  'pd.cancelUpload': 'Cancel upload',
  'pd.startUpload': 'Start upload',
  'pd.dlgIssueToken': 'Issue API token',
  'pd.tokenIssuedPre': 'Token issued — copy now, it will',
  'pd.notShownAgain': 'not be shown again',
  'pd.copyToken': 'Copy token',
  'pd.copied': 'Copied ✓',
  'pd.fldTokenName': 'Name (for your records)',
  'pd.fldKind': 'Kind',
  'pd.kindDevice': 'device (download-only)',
  'pd.kindCi': 'ci (upload/download)',
  'pd.fldTokenScope': 'Scope',
  'pd.scopeUploadOnly': 'upload only',
  'pd.scopeDownloadOnly': 'download only',
  'pd.scopeFullOpt': 'full',
  'pd.fldRestrictChannel': 'Restrict to channel (optional)',
  'pd.issue': 'Issue',

  'mem.title': 'Memberships',
  'mem.allCustomers': 'All customers',
  'mem.projectFilter': '— project filter —',
  'mem.grant': '+ Grant membership',
  'mem.rolesHint':
    'Roles: customer_admin (manage all of customer/project), developer (upload + download), viewer (download only). Super_admin users see everything regardless of memberships.',
  'mem.colUser': 'User',
  'mem.colScope': 'Scope',
  'mem.colTarget': 'Target',
  'mem.colRole': 'Role',
  'mem.colCreated': 'Created',
  'mem.empty': 'No memberships in this view.',
  'mem.confirmRevoke': 'Revoke this membership?',
  'mem.dlgGrant': 'Grant membership',
  'mem.fldUser': 'User',
  'mem.fldScope': 'Scope',
  'mem.scopeCustomer': 'customer (applies to all its projects)',
  'mem.scopeProject': 'project (override)',
  'mem.fldTarget': 'Target',
  'mem.fldRole': 'Role',

  'account.title': 'Account',
  'account.profile': 'Profile',
  'account.email': 'Email',
  'account.role': 'Role',
  'account.displayName': 'Display name',
  'account.saveProfile': 'Save profile',
  'account.profileSavedRelogin': 'Profile updated. Please sign in again…',
  'account.changePw': 'Change password',
  'account.currentPw': 'Current password',
  'account.newPw': 'New password (>=8 chars)',
  'account.confirmPw': 'Confirm password',
  'account.pwMismatch': 'The two passwords do not match',
  'account.pwUpdated': 'Password updated.',
  'account.update': 'Update password',
  'account.updating': 'Updating…',
  'account.failed': 'failed',
};

const DICTS: Record<Lang, Dict> = { zh, en };

function detectDefault(): Lang {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === 'zh' || saved === 'en') return saved;
  const nav = navigator.language?.toLowerCase() ?? '';
  return nav.startsWith('zh') ? 'zh' : 'en';
}

function interpolate(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export type TFn = (key: string, vars?: Record<string, string | number>) => string;

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  toggle: () => void;
  t: TFn;
}

const Ctx = createContext<I18nCtx | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const l = detectDefault();
    document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en';
    return l;
  });

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    localStorage.setItem(LANG_KEY, l);
    document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en';
  }, []);

  const toggle = useCallback(() => {
    setLang(lang === 'zh' ? 'en' : 'zh');
  }, [lang, setLang]);

  const t = useCallback<TFn>(
    (key, vars) => {
      const dict = DICTS[lang];
      const s = dict[key] ?? DICTS.en[key] ?? key;
      return interpolate(s, vars);
    },
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, toggle, t }), [lang, setLang, toggle, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useI18n outside provider');
  return ctx;
}
