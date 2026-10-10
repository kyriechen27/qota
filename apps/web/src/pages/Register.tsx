import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import './registration.css';

export default function Register() {
  const { t } = useI18n();
  const nav = useNavigate();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const submitting = useRef(false);
  const mismatch = confirmation.length > 0 && password !== confirmation;

  useEffect(() => {
    let active = true;
    setLoadFailed(false);
    setEnabled(null);
    api.getRegistrationState().then((state) => {
      if (active) setEnabled(state.enabled);
    }).catch(() => {
      if (active) setLoadFailed(true);
    });
    return () => { active = false; };
  }, [attempt]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !enabled) return;
    if (password !== confirmation) {
      setErrorKey('registration.mismatch');
      return;
    }
    submitting.current = true;
    setBusy(true);
    setErrorKey(null);
    try {
      await api.register({ email: email.trim(), displayName: name.trim() || undefined, password, confirmPassword: confirmation });
      nav('/login', { replace: true, state: { registeredEmail: email.trim() } });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'registration_disabled') {
        setEnabled(false);
        setPassword('');
        setConfirmation('');
      } else {
        setErrorKey(err instanceof ApiError && err.status === 409 ? 'registration.duplicate' : 'registration.failed');
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="login-page registration-page">
      <div className="login-card">
        <h1>{t('registration.title')}</h1>
        {enabled === null ? (
          <div className="registration-notice" role="status">
            {loadFailed ? <><p className="error">{t('registration.loadFailed')}</p><button onClick={() => setAttempt((value) => value + 1)}>{t('registration.retry')}</button></> : t('common.loading')}
          </div>
        ) : !enabled ? (
          <div className="registration-notice" role="status">
            <strong>{t('registration.closed')}</strong>
            <p className="muted">{t('registration.closedHint')}</p>
          </div>
        ) : (
          <form onSubmit={submit}>
            <p className="sub">{t('registration.intro')}</p>
            <label>
              <span className="lbl">{t('registration.email')}</span>
              <input type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} />
            </label>
            <label>
              <span className="lbl">{t('registration.name')}</span>
              <input type="text" autoComplete="nickname" maxLength={128} value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
            </label>
            <label>
              <span className="lbl">{t('registration.password')}</span>
              <input type="password" autoComplete="new-password" required minLength={8} maxLength={128} placeholder={t('registration.passwordHint')} value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} />
            </label>
            <label>
              <span className="lbl">{t('registration.confirm')}</span>
              <input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={busy} aria-invalid={mismatch} aria-describedby={mismatch ? 'registration-password-error' : undefined} />
            </label>
            {mismatch && <p id="registration-password-error" className="error" role="status">{t('registration.mismatch')}</p>}
            {errorKey && <p className="error" role="alert">{t(errorKey)}</p>}
            <button type="submit" className="primary registration-submit" disabled={busy || mismatch || !password || !confirmation}>{t(busy ? 'registration.submitting' : 'registration.submit')}</button>
          </form>
        )}
        <div className="registration-link"><Link to="/login">{t('registration.back')}</Link></div>
      </div>
    </div>
  );
}
