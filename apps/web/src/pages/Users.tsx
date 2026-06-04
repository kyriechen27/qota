import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { assignableGlobalRoles, type GlobalRole, type User } from '@qota/shared';

export default function Users() {
  const { t } = useI18n();
  const { user: me } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{ email: string; password: string; displayName: string; role: GlobalRole }>({
    email: '',
    password: '',
    displayName: '',
    role: 'developer',
  });
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setUsers(await api.listUsers());
    } catch (e: any) {
      setErr(e?.message);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.createUser(form);
      setOpen(false);
      setForm({ email: '', password: '', displayName: '', role: 'developer' });
      await load();
    } catch (e: any) {
      setErr(e?.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(u: User) {
    try {
      await api.updateUser(u.id, { isActive: !u.isActive });
      await load();
    } catch (e: any) {
      setErr(e?.message);
    }
  }

  async function changeRole(u: User, next: GlobalRole) {
    if (next === u.role) return;
    if (!confirm(t('users.confirmRole', { email: u.email, role: t(`role.${next}`) }))) {
      await load(); // reset the (controlled) select back to the current role
      return;
    }
    try {
      await api.updateUser(u.id, { role: next });
      await load();
    } catch (e: any) {
      setErr(e?.message);
      await load();
    }
  }

  async function resetPassword(u: User) {
    const pw = prompt(t('users.promptPw', { email: u.email }));
    if (!pw) return;
    try {
      await api.updateUser(u.id, { password: pw });
      alert(t('users.pwUpdated'));
    } catch (e: any) {
      setErr(e?.message);
    }
  }

  async function remove(u: User) {
    if (!confirm(t('users.confirmDelete', { email: u.email }))) return;
    try {
      await api.deleteUser(u.id);
      await load();
    } catch (e: any) {
      setErr(e?.message);
    }
  }

  return (
    <>
      <h2 className="page-title">{t('users.title')}</h2>
      <div className="page-actions">
        <button className="primary" onClick={() => setOpen(true)}>{t('users.new')}</button>
      </div>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      <table>
        <thead>
          <tr>
            <th>{t('users.colId')}</th>
            <th>{t('users.colEmail')}</th>
            <th>{t('users.colName')}</th>
            <th>{t('users.colRole')}</th>
            <th>{t('users.colStatus')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const superAdmins = users.filter((x) => x.role === 'super_admin').length;
            const isLastSuperAdmin = u.role === 'super_admin' && superAdmins <= 1;
            const assignable = me ? assignableGlobalRoles(me.role) : [];
            const roleOptions = assignable.includes(u.role) ? assignable : [u.role, ...assignable];
            return (
              <tr key={u.id}>
                <td>{u.id}</td>
                <td>{u.email}</td>
                <td>{u.displayName || '—'}</td>
                <td>
                  <select
                    className={`role-select ${u.role}`}
                    value={u.role}
                    disabled={roleOptions.length <= 1 || isLastSuperAdmin}
                    title={isLastSuperAdmin ? t('users.lastSuperAdmin') : undefined}
                    onChange={(e) => changeRole(u, e.target.value as GlobalRole)}
                  >
                    {roleOptions.map((r) => (
                      <option key={r} value={r}>{t(`role.${r}`)}</option>
                    ))}
                  </select>
                </td>
                <td>{u.isActive ? <span className="success">{t('users.active')}</span> : <span className="error">{t('users.disabled')}</span>}</td>
                <td>
                  <button
                    onClick={() => toggle(u)}
                    style={{ marginRight: 6 }}
                    disabled={u.isActive && isLastSuperAdmin}
                    title={u.isActive && isLastSuperAdmin ? t('users.lastSuperAdmin') : undefined}
                  >
                    {u.isActive ? t('users.disable') : t('users.enable')}
                  </button>
                  <button onClick={() => resetPassword(u)} style={{ marginRight: 6 }}>{t('users.resetPw')}</button>
                  <button
                    className="danger"
                    onClick={() => remove(u)}
                    disabled={isLastSuperAdmin}
                    title={isLastSuperAdmin ? t('users.lastSuperAdmin') : undefined}
                  >
                    {t('common.delete')}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {open && (
        <div className="dialog-backdrop" onClick={() => !busy && setOpen(false)}>
          <form className="dialog" onSubmit={create} onClick={(e) => e.stopPropagation()}>
            <h3>{t('users.dlgNew')}</h3>
            <label>
              <span className="lbl">{t('users.fldEmail')}</span>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required style={{ width: '100%' }} />
            </label>
            <label>
              <span className="lbl">{t('users.fldPassword')}</span>
              <input type="text" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required style={{ width: '100%' }} />
            </label>
            <label>
              <span className="lbl">{t('users.fldName')}</span>
              <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} style={{ width: '100%' }} />
            </label>
            <label>
              <span className="lbl">{t('users.fldRole')}</span>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as GlobalRole })} style={{ width: '100%' }}>
                <option value="developer">{t('role.developer')}</option>
                <option value="super_admin">{t('role.super_admin')}</option>
              </select>
            </label>
            <div className="dialog-actions">
              <button type="button" onClick={() => setOpen(false)} disabled={busy}>{t('common.cancel')}</button>
              <button type="submit" className="primary" disabled={busy}>{t('common.create')}</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
