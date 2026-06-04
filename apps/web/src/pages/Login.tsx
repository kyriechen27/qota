import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';

export default function Login() {
  const { login } = useAuth();
  const { t } = useI18n();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await login(email.trim(), password);
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
        <label>
          <span className="lbl">{t('login.email')}</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
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
      </form>
    </div>
  );
}
