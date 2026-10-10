import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import './registration.css';

export default function Login() {
  const { login } = useAuth();
  const { t } = useI18n();
  const nav = useNavigate();
  const location = useLocation();
  const registeredEmail = typeof location.state?.registeredEmail === 'string' ? location.state.registeredEmail : '';
  const [identifier, setIdentifier] = useState(registeredEmail);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [registrationEnabled, setRegistrationEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      api.getRegistrationState().then((state) => {
        if (active) setRegistrationEnabled(state.enabled);
      }).catch(() => { if (active) setRegistrationEnabled(false); });
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => { active = false; window.removeEventListener('focus', refresh); };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await login(identifier.trim(), password);
      nav('/');
    } catch (e: any) {
      setErr(e?.message ?? t('login.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h1>📦 qota</h1>
        <div className="sub">{t('login.subtitle')}</div>
        {registeredEmail && <div className="success registration-success" role="status">{t('registration.success')}</div>}
        <label>
          <span className="lbl">{t('login.email')}</span>
          <input
            type="text"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            autoComplete="username"
            required
            style={{ width: '100%' }}
          />
        </label>
        <label>
          <span className="lbl">{t('login.password')}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            style={{ width: '100%' }}
          />
        </label>
        {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
        <button type="submit" className="primary" disabled={busy} style={{ width: '100%' }}>
          {busy ? t('login.signingin') : t('login.signin')}
        </button>
        {registrationEnabled && <div className="registration-link"><Link to="/register">{t('registration.link')}</Link></div>}
      </form>
    </div>
  );
}
