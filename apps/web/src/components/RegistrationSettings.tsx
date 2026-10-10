import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import './users-registration.css';

export default function RegistrationSettings() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const savingRef = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(null); setSaved(false);
    api.getRegistrationState().then((state) => { if (active) setEnabled(state.enabled); })
      .catch((failure: any) => { if (active) { setEnabled(null); setError(failure?.message || t('registrationSettings.loadError')); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
    // A language change must not restart this request while a toggle is saving.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);
  async function update(next: boolean) {
    if (enabled === null || loading || savingRef.current) return;
    const previous = enabled;
    savingRef.current = true; setSaving(true); setEnabled(next); setError(null); setSaved(false);
    try {
      const state = await api.updateRegistrationState(next);
      if (mounted.current) { setEnabled(state.enabled); setSaved(true); }
    } catch (failure: any) {
      if (mounted.current) { setEnabled(previous); setError(failure?.message || t('registrationSettings.saveError')); }
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return <section className="card registration-settings" aria-labelledby="registration-settings-title">
    <div className="registration-settings-heading">
      <div><h3 id="registration-settings-title">{t('registrationSettings.title')}</h3><p id="registration-settings-description" className="muted">{t('registrationSettings.description')}</p></div>
      <label className="registration-toggle">
        <span className="registration-switch"><input type="checkbox" role="switch" aria-label={t('registrationSettings.enabled')} aria-describedby="registration-settings-description" checked={enabled === true} disabled={loading || saving || enabled === null} onChange={(event) => void update(event.target.checked)} /><span aria-hidden="true" /></span>
        <span>{t('registrationSettings.enabled')}</span>
      </label>
    </div>
    {(loading || saving || saved) && <p className={`registration-settings-status ${saved && !saving ? 'success' : 'muted'}`} role="status">{t(loading ? 'common.loading' : saving ? 'registrationSettings.saving' : 'registrationSettings.saved')}</p>}
    {error && <div className="error registration-settings-error" role="alert"><span>{error}</span>{enabled === null && <button type="button" disabled={loading} onClick={() => setReload((value) => value + 1)}>{t('common.retry')}</button>}</div>}
  </section>;
}
