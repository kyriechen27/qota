// Page renamed conceptually to "Memberships". File path kept as Permissions.tsx
// so existing router imports still resolve; the route is /permissions but the
// nav label and UI are membership-centric in the v2 model.

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { Customer, CustomerRole, Membership, Project, ProjectMembership, User } from '@qota/shared';

type Row =
  | (Membership & { scope: 'customer' })
  | (ProjectMembership & { scope: 'project' });

const ROLES: CustomerRole[] = ['customer_admin', 'developer', 'viewer'];

export default function Memberships() {
  const { t } = useI18n();
  const [users, setUsers] = useState<User[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [filterCustomer, setFilterCustomer] = useState<number | ''>('');
  const [filterProject, setFilterProject] = useState<number | ''>('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{
    userId: number;
    scope: 'customer' | 'project';
    targetId: number;
    role: CustomerRole;
  }>({ userId: 0, scope: 'customer', targetId: 0, role: 'developer' });
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [u, c, p] = await Promise.all([api.listUsers().catch(() => [] as User[]), api.listCustomers(), api.listProjects()]);
      setUsers(u);
      setCustomers(c);
      setProjects(p);
      let r: Row[] = [];
      if (filterProject) {
        r = (await api.listProjectMemberships(filterProject as number)) as Row[];
      } else if (filterCustomer) {
        r = (await api.listCustomerMemberships(filterCustomer as number)) as Row[];
      } else {
        // List all customers visible to me, fan out
        const buckets = await Promise.all(c.map((cu) => api.listCustomerMemberships(cu.id).catch(() => [])));
        r = buckets.flat() as Row[];
      }
      setRows(r);
    } catch (e: any) {
      setErr(e?.message);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterCustomer, filterProject]);

  const userMap = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const custMap = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers]);
  const projMap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  function scopeLabel(r: Row): string {
    if (r.scope === 'customer') {
      const c = custMap.get(r.customerId);
      return c ? `${c.code} (${c.name})` : `#${r.customerId}`;
    }
    const p = projMap.get(r.projectId);
    return p ? `${p.code} (${p.name})` : `#${r.projectId}`;
  }

  async function grant(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.createMembership({
        userId: form.userId,
        customerId: form.scope === 'customer' ? form.targetId : undefined,
        projectId: form.scope === 'project' ? form.targetId : undefined,
        role: form.role,
      });
      setOpen(false);
      setForm({ userId: 0, scope: 'customer', targetId: 0, role: 'developer' });
      await load();
    } catch (e: any) {
      setErr(e?.message);
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(r: Row, role: CustomerRole) {
    try {
      await api.updateMembership(r.id, r.scope, { role });
      await load();
    } catch (e: any) {
      setErr(e?.message);
    }
  }

  async function revoke(r: Row) {
    if (!confirm(t('mem.confirmRevoke'))) return;
    try {
      await api.deleteMembership(r.id, r.scope);
      await load();
    } catch (e: any) {
      setErr(e?.message);
    }
  }

  return (
    <>
      <h2 className="page-title">{t('mem.title')}</h2>
      <div className="page-actions toolbar">
        <select value={filterCustomer} onChange={(e) => { setFilterCustomer(e.target.value ? Number(e.target.value) : ''); setFilterProject(''); }}>
          <option value="">{t('mem.allCustomers')}</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
          ))}
        </select>
        <select value={filterProject} onChange={(e) => { setFilterProject(e.target.value ? Number(e.target.value) : ''); }}>
          <option value="">{t('mem.projectFilter')}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {custMap.get(p.customerId)?.code ?? '?'} / {p.code}
            </option>
          ))}
        </select>
        <button className="primary" onClick={() => setOpen(true)}>{t('mem.grant')}</button>
      </div>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      <div className="muted" style={{ marginBottom: 8 }}>
        {t('mem.rolesHint')}
      </div>
      <table>
        <thead>
          <tr>
            <th>{t('mem.colUser')}</th>
            <th>{t('mem.colScope')}</th>
            <th>{t('mem.colTarget')}</th>
            <th>{t('mem.colRole')}</th>
            <th>{t('mem.colCreated')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const u = userMap.get(r.userId);
            return (
              <tr key={`${r.scope}-${r.id}`}>
                <td>{u ? u.email : `#${r.userId}`}</td>
                <td><span className="tag">{t(`mscope.${r.scope}`)}</span></td>
                <td><span className="code">{scopeLabel(r)}</span></td>
                <td>
                  <select value={r.role} onChange={(e) => changeRole(r, e.target.value as CustomerRole)}>
                    {ROLES.map((role) => (
                      <option key={role} value={role}>{t(`role.${role}`)}</option>
                    ))}
                  </select>
                </td>
                <td className="muted">{new Date(r.createdAt).toLocaleString()}</td>
                <td><button className="danger" onClick={() => revoke(r)}>{t('common.revoke')}</button></td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                {t('mem.empty')}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {open && (
        <div className="dialog-backdrop" onClick={() => !busy && setOpen(false)}>
          <form className="dialog" onSubmit={grant} onClick={(e) => e.stopPropagation()}>
            <h3>{t('mem.dlgGrant')}</h3>
            <label>
              <span className="lbl">{t('mem.fldUser')}</span>
              <select
                value={form.userId}
                onChange={(e) => setForm({ ...form, userId: Number(e.target.value) })}
                required
                style={{ width: '100%' }}
              >
                <option value={0} disabled>{t('common.select')}</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.email}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="lbl">{t('mem.fldScope')}</span>
              <select
                value={form.scope}
                onChange={(e) => setForm({ ...form, scope: e.target.value as 'customer' | 'project', targetId: 0 })}
                style={{ width: '100%' }}
              >
                <option value="customer">{t('mem.scopeCustomer')}</option>
                <option value="project">{t('mem.scopeProject')}</option>
              </select>
            </label>
            <label>
              <span className="lbl">{t('mem.fldTarget')}</span>
              <select
                value={form.targetId}
                onChange={(e) => setForm({ ...form, targetId: Number(e.target.value) })}
                required
                style={{ width: '100%' }}
              >
                <option value={0} disabled>{t('common.select')}</option>
                {form.scope === 'customer'
                  ? customers.map((c) => (
                      <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
                    ))
                  : projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {custMap.get(p.customerId)?.code ?? '?'} / {p.code} — {p.name}
                      </option>
                    ))}
              </select>
            </label>
            <label>
              <span className="lbl">{t('mem.fldRole')}</span>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as CustomerRole })} style={{ width: '100%' }}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>{t(`role.${r}`)}</option>
                ))}
              </select>
            </label>
            <div className="dialog-actions">
              <button type="button" onClick={() => setOpen(false)} disabled={busy}>{t('common.cancel')}</button>
              <button type="submit" className="primary" disabled={busy}>{t('mem.grant').replace('+ ', '')}</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
