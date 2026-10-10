import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { MailSettings as Settings } from '@qota/shared';
import { api, ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import './mail-settings.css';

type Feedback = { ok: boolean; key: string } | null;
const SAFE_CODES = new Set(['smtp_connect', 'smtp_timeout', 'smtp_tls', 'smtp_auth', 'smtp_recipient', 'smtp_send', 'mail_not_configured', 'mail_disabled']);

export default function MailSettings() {
  const { t } = useI18n();
  const [saved, setSaved] = useState<Settings | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testAddress, setTestAddress] = useState('');
  const [saveFeedback, setSaveFeedback] = useState<Feedback>(null);
  const [testFeedback, setTestFeedback] = useState<Feedback>(null);
  const busy = saving || testing;
  const dirty = !!password || JSON.stringify(form) !== JSON.stringify(saved);
  const complete = !!(saved?.host && saved.username && saved.fromEmail && saved.hasPassword);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const result = await api.getMailSettings();
      setSaved(result); setForm(result); setPassword('');
    } catch { setLoadError(true); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  function change<K extends keyof Settings>(key: K, value: Settings[K]) {
    setForm((old) => old ? { ...old, [key]: value } : old);
    setSaveFeedback(null); setTestFeedback(null);
  }
  function errorKey(error: unknown, fallback: string) {
    return error instanceof ApiError && SAFE_CODES.has(error.code) ? `mailSettings.${error.code}` : fallback;
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form || busy) return;
    setSaving(true); setSaveFeedback(null); setTestFeedback(null);
    try {
      const { hasPassword: _, ...values } = form;
      const result = await api.updateMailSettings({ ...values, ...(password ? { password } : {}) });
      setSaved(result); setForm(result); setPassword('');
      setSaveFeedback({ ok: true, key: 'mailSettings.saved' });
    } catch (error) { setSaveFeedback({ ok: false, key: errorKey(error, 'mailSettings.saveFailed') }); }
    finally { setSaving(false); }
  }
  async function test(event: FormEvent) {
    event.preventDefault();
    if (dirty || !complete || busy || !testAddress.trim()) return;
    setTesting(true); setTestFeedback(null);
    try {
      await api.testMail(testAddress.trim());
      setTestFeedback({ ok: true, key: 'mailSettings.testSuccess' });
    } catch (error) { setTestFeedback({ ok: false, key: errorKey(error, 'mailSettings.testFailed') }); }
    finally { setTesting(false); }
  }

  return <div className="mail-settings-page">
    <header className="mail-settings-header">
      <h2 className="page-title">{t('mailSettings.title')}</h2>
      <p>{t('mailSettings.subtitle')}</p>
    </header>
    {loading ? <div className="card" role="status">{t('common.loading')}</div> : loadError || !form ?
      <div className="card"><p className="error" role="alert">{t('mailSettings.loadFailed')}</p><button onClick={() => void load()}>{t('mailSettings.retry')}</button></div> : <>
      <section className="card mail-settings-card">
        <h3>{t('mailSettings.connection')}</h3>
        <p className="mail-settings-hint">{t('mailSettings.connectionHint')}</p>
        <form onSubmit={save}>
          <fieldset disabled={busy} className="mail-settings-fields">
            <label className="mail-settings-toggle">
              <input type="checkbox" checked={form.enabled} onChange={(event) => change('enabled', event.target.checked)} />
              <span><strong>{t('mailSettings.enabled')}</strong><small>{t('mailSettings.enabledHint')}</small></span>
            </label>
            <div className="mail-settings-grid">
              <label className="mail-settings-wide"><span className="lbl">{t('mailSettings.host')}</span>
                <input value={form.host} maxLength={253} placeholder="smtp.example.com" autoCapitalize="none" spellCheck={false} onChange={(event) => change('host', event.target.value)} required={form.enabled} />
              </label>
              <label><span className="lbl">{t('mailSettings.security')}</span>
                <select value={form.security} onChange={(event) => {
                  const security = event.target.value as Settings['security'];
                  setForm({ ...form, security, port: form.port === 465 || form.port === 587 ? security === 'tls' ? 465 : 587 : form.port });
                  setSaveFeedback(null); setTestFeedback(null);
                }}><option value="tls">{t('mailSettings.tls')}</option><option value="starttls">{t('mailSettings.starttls')}</option></select>
              </label>
              <label><span className="lbl">{t('mailSettings.port')}</span>
                <input type="number" min={1} max={65535} value={form.port || ''} onChange={(event) => change('port', Number(event.target.value))} required />
              </label>
              <label><span className="lbl">{t('mailSettings.username')}</span>
                <input value={form.username} maxLength={320} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={(event) => change('username', event.target.value)} required={form.enabled} />
              </label>
              <label><span className="lbl">{t('mailSettings.password')}</span>
                <input type="password" value={password} maxLength={4096} autoComplete="new-password" placeholder={t(form.hasPassword ? 'mailSettings.passwordSaved' : 'mailSettings.passwordNew')} onChange={(event) => { setPassword(event.target.value); setSaveFeedback(null); setTestFeedback(null); }} required={form.enabled && !form.hasPassword} />
              </label>
              <p className="mail-settings-hint mail-settings-wide">{t('mailSettings.passwordHint')}</p>
              <label><span className="lbl">{t('mailSettings.fromEmail')}</span>
                <input type="email" value={form.fromEmail} maxLength={254} autoCapitalize="none" onChange={(event) => change('fromEmail', event.target.value)} required={form.enabled} />
              </label>
              <label><span className="lbl">{t('mailSettings.fromName')}</span>
                <input value={form.fromName} maxLength={200} placeholder={t('mailSettings.fromNamePlaceholder')} onChange={(event) => change('fromName', event.target.value)} />
              </label>
            </div>
          </fieldset>
          <footer className="mail-settings-footer">
            <div aria-live="polite">{saveFeedback && <p className={saveFeedback.ok ? 'success' : 'error'}>{t(saveFeedback.key)}</p>}</div>
            <button className="primary" type="submit" disabled={busy || !dirty}>{t(saving ? 'mailSettings.saving' : 'mailSettings.save')}</button>
          </footer>
        </form>
      </section>
      <section className="card mail-settings-card mail-settings-test">
        <h3>{t('mailSettings.test')}</h3>
        <p className="mail-settings-hint">{t('mailSettings.testHint')}</p>
        <form onSubmit={test}>
          <div className="mail-settings-test-row">
            <label><span className="lbl">{t('mailSettings.testAddress')}</span>
              <input type="email" value={testAddress} maxLength={254} placeholder="test@example.com" autoComplete="email" disabled={busy} onChange={(event) => { setTestAddress(event.target.value); setTestFeedback(null); }} required />
            </label>
            <button type="submit" disabled={busy || dirty || !complete || !testAddress.trim()}>{t(testing ? 'mailSettings.testing' : 'mailSettings.sendTest')}</button>
          </div>
          {(dirty || !complete) && <p className="mail-settings-hint">{t(dirty ? 'mailSettings.saveFirst' : 'mailSettings.incomplete')}</p>}
          {testFeedback && <p role={testFeedback.ok ? 'status' : 'alert'} className={testFeedback.ok ? 'success' : 'error'}>{t(testFeedback.key)}</p>}
        </form>
      </section>
    </>}
  </div>;
}
