import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import RegistrationSettings from '../components/RegistrationSettings';
import '../components/users-registration.css';
import {
  GLOBAL_ROLES,
  assignableGlobalRoles,
  canManageGlobalRole,
  type GlobalRole,
  type User,
} from '@qota/shared';

export default function Users() {
  const { t } = useI18n();
  const { user: me } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [resetUser, setResetUser] = useState<User | null>(null);
  const [form, setForm] = useState<{ email: string; password: string; confirmPassword: string; displayName: string; role: GlobalRole }>({
    email: '',
    password: '',
    confirmPassword: '',
    displayName: '',
    role: 'developer',
  });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const createDialog = useRef<HTMLDialogElement>(null);
  const createRoleOptions = me ? assignableGlobalRoles(me.role) : [];
  const passwordMismatch = !!form.confirmPassword && form.password !== form.confirmPassword;
  const passwordValid = form.password.length >= 8 && form.password.length <= 128 && form.password === form.confirmPassword;
  useEffect(() => {
    if (!open) return;
    const dialog = createDialog.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, [open]);

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
    if (busyRef.current) return;
    if (form.password.length < 8 || form.password.length > 128) { setCreateError(t('password.invalidLength')); return; }
    if (form.password !== form.confirmPassword) { setCreateError(t('password.mismatch')); return; }
    busyRef.current = true;
    setBusy(true);
    setCreateError(null);
    setSuccess(null);
    try {
      await api.createUser(form);
      setOpen(false);
      setForm({ email: '', password: '', confirmPassword: '', displayName: '', role: 'developer' });
      await load();
    } catch (e: any) {
      setCreateError(e?.message);
    } finally {
      busyRef.current = false;
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
        <button
          className="primary"
          onClick={() => {
            setForm((cur) => ({ ...cur, password: '', confirmPassword: '', role: createRoleOptions.includes(cur.role) ? cur.role : (createRoleOptions[0] ?? 'developer') }));
            setCreateError(null);
            setOpen(true);
          }}
        >
          {t('users.new')}
        </button>
      </div>
      <RegistrationSettings />
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      {success && <div className="success" role="status" style={{ marginBottom: 12 }}>{success}</div>}
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
            const canManageUser = me ? canManageGlobalRole(me.role, u.role) : false;
            const assignable = me && canManageUser ? assignableGlobalRoles(me.role) : [];
            const roleOptions = assignable.includes(u.role) ? assignable : [u.role, ...assignable];
            const disabledTitle = isLastSuperAdmin
              ? t('users.lastSuperAdmin')
              : !canManageUser
                ? t('users.roleProtected')
                : undefined;
            return (
              <tr key={u.id}>
                <td>{u.id}</td>
                <td>{u.email}</td>
                <td>{u.displayName || '—'}</td>
                <td>
                  <select
                    className={`role-select ${u.role}`}
                    value={u.role}
                    disabled={roleOptions.length <= 1 || isLastSuperAdmin || !canManageUser}
                    title={disabledTitle}
                    onChange={(e) => changeRole(u, e.target.value as GlobalRole)}
                  >
                    {roleOptions.map((r) => (
                      <option key={r} value={r}>{t(`role.${r}`)}</option>
                    ))}
                  </select>
                </td>
                <td>{u.isActive ? <span className="success">{t('users.active')}</span> : <span className="error">{t('users.disabled')}</span>}</td>
                <td>
                  <Link to={`/permissions?userId=${u.id}`} className="btn" style={{ marginRight: 6 }}>
                    {t('mem.title')}
                  </Link>
                  <button
                    onClick={() => toggle(u)}
                    style={{ marginRight: 6 }}
                    disabled={(u.isActive && isLastSuperAdmin) || !canManageUser}
                    title={disabledTitle}
                  >
                    {u.isActive ? t('users.disable') : t('users.enable')}
                  </button>
                  <button onClick={() => { setSuccess(null); setResetUser(u); }} style={{ marginRight: 6 }} disabled={!canManageUser} title={disabledTitle}>
                    {t('users.resetPw')}
                  </button>
                  <button
                    className="danger"
                    onClick={() => remove(u)}
                    disabled={isLastSuperAdmin || !canManageUser}
                    title={disabledTitle}
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
        <dialog ref={createDialog} className="dialog user-password-dialog" aria-labelledby="create-user-title" onCancel={(event) => { event.preventDefault(); if (!busyRef.current) setOpen(false); }}>
          <form onSubmit={create}>
            <h3 id="create-user-title">{t('users.dlgNew')}</h3>
            {createError && <div className="error" role="alert">{createError}</div>}
            <fieldset disabled={busy}>
            <label>
              <span className="lbl">{t('users.fldEmail')}</span>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required autoComplete="off" autoFocus style={{ width: '100%' }} />
            </label>
            <label>
              <span className="lbl">{t('users.fldPassword')}</span>
              <input type="password" minLength={8} maxLength={128} value={form.password} onChange={(e) => { setCreateError(null); setForm({ ...form, password: e.target.value }); }} required autoComplete="new-password" style={{ width: '100%' }} />
            </label>
            <label><span className="lbl">{t('password.confirmPassword')}</span><input type="password" minLength={8} maxLength={128} value={form.confirmPassword} onChange={(e) => { setCreateError(null); setForm({ ...form, confirmPassword: e.target.value }); }} required autoComplete="new-password" aria-invalid={passwordMismatch} aria-describedby={passwordMismatch ? 'create-password-mismatch' : undefined} /></label>
            <p className="password-range-hint">{t('password.rangeHint')}</p>
            {passwordMismatch && <p className="error password-confirmation-message" id="create-password-mismatch" role="alert">{t('password.mismatch')}</p>}
            <label>
              <span className="lbl">{t('users.fldName')}</span>
              <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} style={{ width: '100%' }} />
            </label>
            <label>
              <span className="lbl">{t('users.fldRole')}</span>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as GlobalRole })} style={{ width: '100%' }}>
                {(createRoleOptions.length ? createRoleOptions : GLOBAL_ROLES).map((role) => (
                  <option key={role} value={role}>
                    {t(`role.${role}`)}
                  </option>
                ))}
              </select>
            </label>
            </fieldset>
            <div className="dialog-actions">
              <button type="button" onClick={() => setOpen(false)} disabled={busy}>{t('common.cancel')}</button>
              <button type="submit" className="primary" disabled={busy || !passwordValid}>{t(busy ? 'common.loading' : 'common.create')}</button>
            </div>
          </form>
        </dialog>
      )}
      {resetUser && <ResetPasswordDialog user={resetUser} onClose={() => setResetUser(null)} onSaved={() => { setResetUser(null); setSuccess(t('users.pwUpdated')); }} />}
    </>
  );
}

function ResetPasswordDialog({ user, onClose, onSaved }: { user: User; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = !!confirmPassword && password !== confirmPassword;
  const valid = password.length >= 8 && password.length <= 128 && password === confirmPassword;
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current) return;
    if (password.length < 8 || password.length > 128) { setError(t('password.invalidLength')); return; }
    if (password !== confirmPassword) { setError(t('password.mismatch')); return; }
    busyRef.current = true; setBusy(true); setError(null);
    try { await api.resetUserPassword(user.id, password, confirmPassword); onSaved(); }
    catch (failure: any) { setError(failure.message); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className="dialog user-password-dialog" aria-labelledby="reset-password-title" onCancel={(event) => { event.preventDefault(); if (!busyRef.current) onClose(); }}>
    <form onSubmit={submit}>
      <h3 id="reset-password-title">{t('users.resetPw')}</h3>
      <p className="password-dialog-description">{t('users.resetPasswordFor', { email: user.email })}</p>
      {error && <div className="error" role="alert">{error}</div>}
      <fieldset disabled={busy}>
        <label><span className="lbl">{t('password.newPassword')}</span><input type="password" minLength={8} maxLength={128} value={password} onChange={(event) => { setPassword(event.target.value); setError(null); }} required autoComplete="new-password" autoFocus /></label>
        <label><span className="lbl">{t('password.confirmPassword')}</span><input type="password" minLength={8} maxLength={128} value={confirmPassword} onChange={(event) => { setConfirmPassword(event.target.value); setError(null); }} required autoComplete="new-password" aria-invalid={mismatch} aria-describedby={mismatch ? 'reset-password-mismatch' : undefined} /></label>
        <p className="password-range-hint">{t('password.rangeHint')}</p>
        {mismatch && <p className="error password-confirmation-message" id="reset-password-mismatch" role="alert">{t('password.mismatch')}</p>}
      </fieldset>
      <div className="dialog-actions"><button type="button" onClick={onClose} disabled={busy}>{t('common.cancel')}</button><button type="submit" className="primary" disabled={busy || !valid}>{t(busy ? 'common.loading' : 'users.resetPasswordSubmit')}</button></div>
    </form>
  </dialog>;
}
