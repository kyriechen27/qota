import { useRef, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import '../components/users-registration.css';

export default function Account() {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const [email, setEmail] = useState(user?.email ?? '');
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [profileMsg, setProfileMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);

  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirmPassword, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mismatch = !!confirmPassword && newPassword !== confirmPassword;
  const passwordValid = newPassword.length >= 8 && newPassword.length <= 128 && newPassword === confirmPassword;

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setProfileBusy(true);
    setProfileMsg(null);
    try {
      await api.updateProfile({ email: email.trim(), displayName: displayName.trim() || null });
      // Profile (incl. email, which is baked into the JWT) changed — force a
      // fresh login so the session reflects the new identity.
      setProfileMsg({ ok: true, text: t('account.profileSavedRelogin') });
      setTimeout(() => logout(), 1200);
    } catch (e: any) {
      setProfileMsg({ ok: false, text: e?.message ?? t('account.failed') });
      setProfileBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busyRef.current) return;
    if (newPassword.length < 8 || newPassword.length > 128) {
      setMsg({ ok: false, text: t('password.invalidLength') });
      return;
    }
    if (newPassword !== confirmPassword) {
      setMsg({ ok: false, text: t('account.pwMismatch') });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setMsg(null);
    try {
      await api.changePassword(oldPassword, newPassword, confirmPassword);
      setMsg({ ok: true, text: t('account.pwUpdated') });
      setOld('');
      setNew('');
      setConfirm('');
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message ?? t('account.failed') });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <h2 className="page-title">{t('account.title')}</h2>
      <div className="card">
        <h3>{t('account.profile')}</h3>
        <form onSubmit={saveProfile}>
          <label>
            <span className="lbl">{t('account.email')}</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={{ width: '100%', maxWidth: 360 }}
            />
          </label>
          <label>
            <span className="lbl">{t('account.displayName')}</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              style={{ width: '100%', maxWidth: 360 }}
            />
          </label>
          <div style={{ marginBottom: 12 }}>
            {t('account.role')}: <span className={`tag ${user?.role}`}>{user ? t(`role.${user.role}`) : ''}</span>
          </div>
          {profileMsg && <div className={profileMsg.ok ? 'success' : 'error'} style={{ marginBottom: 12 }}>{profileMsg.text}</div>}
          <button type="submit" className="primary" disabled={profileBusy}>
            {profileBusy ? t('account.updating') : t('account.saveProfile')}
          </button>
        </form>
      </div>
      <div className="card">
        <h3>{t('account.changePw')}</h3>
        <form onSubmit={submit}>
          <label>
            <span className="lbl">{t('account.currentPw')}</span>
            <input type="password" value={oldPassword} onChange={(e) => { setOld(e.target.value); setMsg(null); }} required disabled={busy} autoComplete="current-password" style={{ width: '100%', maxWidth: 360 }} />
          </label>
          <label>
            <span className="lbl">{t('account.newPw')}</span>
            <input type="password" minLength={8} maxLength={128} value={newPassword} onChange={(e) => { setNew(e.target.value); setMsg(null); }} required disabled={busy} autoComplete="new-password" style={{ width: '100%', maxWidth: 360 }} />
          </label>
          <label>
            <span className="lbl">{t('account.confirmPw')}</span>
            <input
              type="password"
              minLength={8}
              maxLength={128}
              value={confirmPassword}
              onChange={(e) => { setConfirm(e.target.value); setMsg(null); }}
              required
              disabled={busy}
              autoComplete="new-password"
              aria-invalid={mismatch}
              aria-describedby={mismatch ? 'account-password-mismatch' : undefined}
              style={{ width: '100%', maxWidth: 360 }}
            />
          </label>
          <p className="password-range-hint">{t('password.rangeHint')}</p>
          {mismatch && <p className="error password-confirmation-message" id="account-password-mismatch" role="alert">{t('password.mismatch')}</p>}
          {msg && <div className={msg.ok ? 'success' : 'error'} style={{ marginBottom: 12 }}>{msg.text}</div>}
          <button type="submit" className="primary" disabled={busy || !oldPassword || !passwordValid}>{busy ? t('account.updating') : t('account.update')}</button>
        </form>
      </div>
    </>
  );
}
