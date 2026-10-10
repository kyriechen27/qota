import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { customerHierarchy } from '../lib/customer-tree';
import type { Customer, CustomerRole, Membership, Project, ProjectMembership, User } from '@qota/shared';
import './customer-memberships.css';

type Row = (Membership & { scope: 'customer' }) | (ProjectMembership & { scope: 'project' });
const ROLES: CustomerRole[] = ['customer_admin', 'developer', 'viewer'];
const MAX_PROJECTS = 200;
function userLabel(user: User) { return user.displayName?.trim() ? `${user.displayName.trim()} (${user.email})` : user.email; }

// Keep large customer trees from spawning an unbounded number of simultaneous requests.
async function loadGrants(customers: Customer[], projects: Project[]): Promise<Row[]> {
  const jobs: (() => Promise<Row[]>)[] = [
    ...customers.map((customer) => () => api.listCustomerMemberships(customer.id)),
    ...projects.map((project) => () => api.listProjectMemberships(project.id)),
  ];
  const buckets: Row[][] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, jobs.length) }, async () => {
    while (next < jobs.length) { const index = next++; buckets[index] = await jobs[index]!(); }
  }));
  return buckets.flat();
}

export default function Memberships() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const userParam = Number(params.get('userId'));
  const filterUser = Number.isSafeInteger(userParam) && userParam > 0 ? userParam : '';
  const [users, setUsers] = useState<User[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [filterCustomer, setFilterCustomer] = useState<number | ''>('');
  const [filterProject, setFilterProject] = useState<number | ''>('');
  const [open, setOpen] = useState(false);
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const mutationRef = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current;
    setLoading(true); setErr(null);
    void (async () => {
      const [nextUsers, nextCustomers, nextProjects] = await Promise.all([api.listUsers(), api.listCustomers(), api.listProjects()]);
      const nextRows = await loadGrants(nextCustomers, nextProjects);
      if (request !== generation.current) return;
      setUsers(nextUsers); setCustomers(nextCustomers); setProjects(nextProjects); setRows(nextRows);
    })().catch((error) => { if (request === generation.current) setErr(error.message); })
      .finally(() => { if (request === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [reload]);

  const tree = useMemo(() => customerHierarchy(customers), [customers]);
  const userMap = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
  const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const filteredProjects = projects.filter((project) => !filterCustomer || project.customerId === filterCustomer);
  const filteredRows = rows.filter((row) => {
    if (filterUser && row.userId !== filterUser) return false;
    if (filterProject) return row.scope === 'project' ? row.projectId === filterProject : row.customerId === projectMap.get(filterProject)?.customerId;
    if (!filterCustomer) return true;
    return row.scope === 'customer' ? row.customerId === filterCustomer : projectMap.get(row.projectId)?.customerId === filterCustomer;
  });
  const customerPath = (id: number) => tree.paths.get(id) ?? `#${id}`;
  const projectLabel = (project: Project) => `${project.name} (${project.code}) / ${customerPath(project.customerId)}`;
  function scopeLabel(row: Row) {
    if (row.scope === 'customer') return customerPath(row.customerId);
    const project = projectMap.get(row.projectId);
    return project ? projectLabel(project) : `#${row.projectId}`;
  }
  async function mutate(row: Row, role?: CustomerRole) {
    if (mutationRef.current || loading) return;
    if (!role && !confirm(t('mem.confirmRevoke'))) return;
    mutationRef.current = true; setBusyRow(`${row.scope}-${row.id}`); setErr(null);
    const request = generation.current;
    try {
      if (role) {
        const updated = await api.updateMembership(row.id, row.scope, { role });
        if (request === generation.current) setRows((current) => current.map((item) => item.scope === row.scope && item.id === row.id ? { ...item, ...updated } as Row : item));
      } else {
        await api.deleteMembership(row.id, row.scope);
        if (request === generation.current) setRows((current) => current.filter((item) => item.scope !== row.scope || item.id !== row.id));
      }
    } catch (error: any) { if (request === generation.current) setErr(error.message); }
    finally { mutationRef.current = false; setBusyRow(null); }
  }
  return <>
    <h2 className="page-title">{t('mem.title')}</h2>
    <div className="page-actions toolbar membership-filters">
      <select aria-label={t('mem.filterUser')} value={filterUser} onChange={(event) => { const next = new URLSearchParams(params); if (event.target.value) next.set('userId', event.target.value); else next.delete('userId'); setParams(next); }}>
        <option value="">{t('mem.allUsers')}</option>{filterUser && !userMap.has(filterUser) && <option value={filterUser}>#{filterUser}</option>}{users.map((user) => <option key={user.id} value={user.id}>{userLabel(user)}</option>)}
      </select>
      <select aria-label={t('mem.filterCustomer')} value={filterCustomer} onChange={(event) => { setFilterCustomer(event.target.value ? Number(event.target.value) : ''); setFilterProject(''); }}>
        <option value="">{t('mem.allCustomers')}</option>{tree.entries.map(({ customer, path }) => <option key={customer.id} value={customer.id}>{path} ({customer.code})</option>)}
      </select>
      <select aria-label={t('mem.filterProject')} value={filterProject} onChange={(event) => setFilterProject(event.target.value ? Number(event.target.value) : '')}>
        <option value="">{t('mem.projectFilter')}</option>{filteredProjects.map((project) => <option key={project.id} value={project.id}>{projectLabel(project)}</option>)}
      </select>
      <button className="primary" disabled={loading || !!err || busyRow !== null} onClick={() => setOpen(true)}>{t('mem.grant')}</button>
    </div>
    {err && <div className="error hierarchy-error" role="alert">{err}<button onClick={() => setReload((value) => value + 1)} disabled={loading || busyRow !== null}>{t('common.retry')}</button></div>}
    <p className="muted hierarchy-intro">{t('mem.rolesHint')}</p>
    <p className="muted hierarchy-intro">{t('mem.independentHint')}</p>
    <div className="hierarchy-table-scroll"><table className="membership-table">
      <thead><tr><th>{t('mem.colUser')}</th><th>{t('mem.colScope')}</th><th>{t('mem.colTarget')}</th><th>{t('mem.colRole')}</th><th>{t('mem.colCreated')}</th><th>{t('customers.actions')}</th></tr></thead>
      <tbody>{filteredRows.map((row) => {
        const user = userMap.get(row.userId);
        return <tr key={`${row.scope}-${row.id}`} data-membership-id={`${row.scope}-${row.id}`}>
          <td>{user ? userLabel(user) : `#${row.userId}`}</td><td><span className="tag">{t(row.scope === 'customer' ? 'mem.customerGrantLabel' : 'mscope.project')}</span></td><td className="membership-target">{scopeLabel(row)}</td>
          <td><select aria-label={t('mem.roleFor', { user: user ? userLabel(user) : `#${row.userId}`, target: scopeLabel(row) })} value={row.role} disabled={loading || busyRow !== null} onChange={(event) => void mutate(row, event.target.value as CustomerRole)}>{ROLES.map((role) => <option key={role} value={role}>{t(`role.${role}`)}</option>)}</select></td>
          <td className="muted customer-tree-date">{new Date(row.createdAt).toLocaleString()}</td>
          <td><button className="danger" disabled={loading || busyRow !== null} onClick={() => void mutate(row)}>{busyRow === `${row.scope}-${row.id}` ? t('common.loading') : t('common.revoke')}</button></td>
        </tr>;
      })}{!filteredRows.length && <tr><td colSpan={6} className="muted hierarchy-empty">{t(loading ? 'common.loading' : 'mem.empty')}</td></tr>}</tbody>
    </table></div>
    {open && <GrantDialog users={users} customers={customers} projects={projects} rows={rows} loading={loading} loadError={err} initialUserId={filterUser || 0} initialCustomerId={filterCustomer || (filterProject ? projectMap.get(filterProject)?.customerId ?? 0 : 0)} initialProjectId={filterProject || 0} onClose={() => setOpen(false)} onRefresh={() => setReload((value) => value + 1)} onSaved={(added) => { setRows((current) => [...current, ...added]); setOpen(false); }} />}
  </>;
}

function GrantDialog({ users, customers, projects, rows, loading, loadError, initialUserId, initialCustomerId, initialProjectId, onClose, onRefresh, onSaved }: {
  users: User[]; customers: Customer[]; projects: Project[]; rows: Row[]; loading: boolean; loadError: string | null;
  initialUserId: number; initialCustomerId: number; initialProjectId: number;
  onClose: () => void; onRefresh: () => void; onSaved: (rows: Row[]) => void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState(users.some((user) => user.id === initialUserId) ? initialUserId : 0);
  const [customerId, setCustomerId] = useState(initialCustomerId);
  const [scope, setScope] = useState<'project' | 'customer'>('project');
  const [role, setRole] = useState<CustomerRole>('developer');
  const [selected, setSelected] = useState<Set<number>>(new Set(initialProjectId ? [initialProjectId] : []));
  const tree = useMemo(() => customerHierarchy(customers), [customers]);
  const selectedUser = users.find((user) => user.id === userId);
  const hasGlobalAccess = selectedUser && ['super_admin', 'admin', 'observer'].includes(selectedUser.role);
  const directProjects = projects.filter((project) => project.customerId === customerId);
  const existingProjects = new Map(rows.filter((row): row is ProjectMembership & { scope: 'project' } => row.scope === 'project' && row.userId === userId).map((row) => [row.projectId, row]));
  const existingCustomer = rows.find((row) => row.scope === 'customer' && row.customerId === customerId && row.userId === userId);
  const eligible = directProjects.filter((project) => !existingProjects.has(project.id));
  const selectedIds = eligible.filter((project) => selected.has(project.id)).map((project) => project.id);
  const eligibleKey = eligible.map((project) => project.id).join(',');
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const available = new Set(eligibleKey.split(',').filter(Boolean).map(Number));
    setSelected((current) => new Set([...current].filter((id) => available.has(id))));
  }, [eligibleKey]);
  function resetChoices() { setSelected(new Set()); setError(null); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || loading || loadError || !userId || !customerId) return;
    if (scope === 'project' && (!selectedIds.length || selectedIds.length > MAX_PROJECTS)) { setError(t('mem.chooseProjects')); return; }
    if (scope === 'customer' && existingCustomer) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      if (scope === 'project') {
        const result = await api.createProjectMemberships({ userId, projectIds: selectedIds, role });
        onSaved(result.items.map((item) => ({ ...item, scope: 'project' as const })));
      } else {
        const result = await api.createMembership({ userId, customerId, role }) as Membership;
        onSaved([{ ...result, scope: 'customer' }]);
      }
    } catch (failure: any) {
      setError(failure.message);
      if (failure instanceof ApiError && failure.status === 409) onRefresh();
    } finally { busyRef.current = false; setBusy(false); }
  }
  const disabled = busy || loading;
  return <dialog ref={dialog} className="dialog hierarchy-dialog membership-grant-dialog" aria-labelledby="membership-grant-title" onCancel={(event) => { event.preventDefault(); if (!busyRef.current) onClose(); }}>
    <form onSubmit={submit}>
      <h3 id="membership-grant-title">{t('mem.dlgGrant')}</h3>
      {(error || loadError) && <div className="error hierarchy-error" role="alert">{error || loadError}{loadError && <button type="button" onClick={onRefresh} disabled={disabled}>{t('common.retry')}</button>}</div>}
      <fieldset disabled={disabled}>
        <label><span className="lbl">{t('mem.fldUser')}</span><select aria-label={t('mem.fldUser')} value={userId || ''} onChange={(event) => { setUserId(Number(event.target.value)); resetChoices(); }} required><option value="" disabled>{t('common.select')}</option>{users.map((user) => <option key={user.id} value={user.id}>{userLabel(user)}</option>)}</select></label>
        {hasGlobalAccess && <p className="membership-scope-note membership-existing-note">{t('mem.globalAccessHint')}</p>}
        <label><span className="lbl">{t('mem.fldCustomer')}</span><select aria-label={t('mem.fldCustomer')} value={customerId || ''} onChange={(event) => { setCustomerId(Number(event.target.value)); resetChoices(); }} required><option value="" disabled>{t('common.select')}</option>{tree.entries.map(({ customer, path }) => <option key={customer.id} value={customer.id}>{path} ({customer.code})</option>)}</select></label>
        <label><span className="lbl">{t('mem.fldScope')}</span><select aria-label={t('mem.fldScope')} value={scope} onChange={(event) => { setScope(event.target.value as 'project' | 'customer'); resetChoices(); }}><option value="project">{t('mem.scopeProject')}</option><option value="customer">{t('mem.scopeCustomer')}</option></select></label>
        <p className="membership-scope-note">{t(scope === 'project' ? 'mem.projectScopeHint' : 'mem.customerScopeHint')}</p>
        {existingCustomer && <p className="membership-scope-note membership-existing-note">{t(scope === 'project' ? 'mem.existingCustomerHint' : 'mem.existingCustomer', { role: t(`role.${existingCustomer.role}`) })}</p>}
        {scope === 'project' && <section className="membership-project-picker" aria-labelledby="membership-projects-title">
          <div className="membership-picker-heading"><strong id="membership-projects-title">{t('mem.selectProjects')}</strong><span className="muted" aria-live="polite">{t('mem.selectedCount', { count: selectedIds.length })}</span></div>
          {customerId && userId ? <>
            <div className="membership-picker-actions"><button type="button" onClick={() => setSelected(new Set(eligible.slice(0, MAX_PROJECTS).map((project) => project.id)))} disabled={!eligible.length || selectedIds.length === Math.min(eligible.length, MAX_PROJECTS)}>{t(eligible.length > MAX_PROJECTS ? 'mem.selectFirst200' : 'mem.selectAll')}</button><button type="button" onClick={() => setSelected(new Set())} disabled={!selectedIds.length}>{t('mem.deselectAll')}</button></div>
            {eligible.length > MAX_PROJECTS && <p className="muted hierarchy-field-hint">{t('mem.batchLimit')}</p>}
            <div className="membership-project-list">{directProjects.map((project) => {
              const existing = existingProjects.get(project.id);
              return <label key={project.id} className={`membership-project-option${existing ? ' membership-project-existing' : ''}`}>
                <input type="checkbox" name="projectIds" value={project.id} checked={!existing && selected.has(project.id)} disabled={!!existing || (!selected.has(project.id) && selectedIds.length >= MAX_PROJECTS)} aria-label={t('mem.selectProjectNamed', { name: project.name })} onChange={(event) => { setError(null); setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(project.id); else next.delete(project.id); return next; }); }} />
                <span><strong>{project.name}</strong><small className="muted">{project.code}</small></span>{existing && <span className="tag">{t('mem.existingRole', { role: t(`role.${existing.role}`) })}</span>}
              </label>;
            })}{!directProjects.length && <p className="muted hierarchy-empty">{t('mem.noDirectProjects')}</p>}</div>
          </> : <p className="muted hierarchy-empty">{t('mem.chooseUserCustomer')}</p>}
        </section>}
        <label><span className="lbl">{t('mem.fldRole')}</span><select aria-label={t('mem.fldRole')} value={role} onChange={(event) => setRole(event.target.value as CustomerRole)}>{ROLES.map((item) => <option key={item} value={item}>{t(`role.${item}`)}</option>)}</select></label>
      </fieldset>
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>{t('common.cancel')}</button><button className="primary" type="submit" disabled={disabled || !!loadError || !userId || !customerId || (scope === 'project' ? !selectedIds.length : !!existingCustomer)}>{t(busy ? 'common.loading' : 'mem.submitGrant')}</button></div>
    </form>
  </dialog>;
}
