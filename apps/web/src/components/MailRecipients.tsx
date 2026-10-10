import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type MailRecipient } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import './mail.css';

export interface MailSelection { enabled: boolean; recipientIds: number[] }
export const emptyMailSelection = (): MailSelection => ({ enabled: false, recipientIds: [] });

export default function MailRecipients({ projectId, value, onChange, onReadyChange, disabled = false }: {
  projectId?: number;
  value: MailSelection;
  onChange: (value: MailSelection) => void;
  onReadyChange: (ready: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const { user } = useAuth();
  const [status, setStatus] = useState<{ enabled: boolean; configured: boolean } | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusRetry, setStatusRetry] = useState(0);
  const [recipients, setRecipients] = useState<MailRecipient[]>([]);
  const [loadedProjectId, setLoadedProjectId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState('');
  const previousProject = useRef(projectId);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const available = !!status?.enabled && status.configured;
  const selected = new Set(value.recipientIds);
  const selectionReady = !value.enabled || (available && loadedProjectId === projectId && !loading && !error
    && selected.size > 0 && selected.size <= 200 && value.recipientIds.every((id) => recipients.some((recipient) => recipient.id === id)));

  useEffect(() => { onReadyChange(selectionReady); }, [selectionReady, onReadyChange]);

  useEffect(() => {
    let active = true;
    setStatus(null);
    setStatusError(null);
    void api.getMailStatus().then((result) => { if (active) setStatus(result); }).catch((e: any) => {
      if (active) setStatusError(e?.message ?? String(e));
    });
    return () => { active = false; };
  }, [statusRetry]);

  useEffect(() => {
    if (previousProject.current !== projectId) {
      previousProject.current = projectId;
      onChangeRef.current(emptyMailSelection());
      setSearch('');
    }
  }, [projectId]);

  useEffect(() => {
    let active = true;
    setRecipients([]);
    setLoadedProjectId(null);
    setError(null);
    setLoading(false);
    if (!projectId || !value.enabled || !available) return;
    setLoading(true);
    void api.listAnnouncementRecipients(projectId).then((result) => {
      if (!active) return;
      setRecipients(result.items);
      setLoadedProjectId(projectId);
    }).catch((e: any) => { if (active) setError(e?.message ?? String(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId, value.enabled, available, retry]);

  const filtered = recipients.filter((recipient) => `${recipient.displayName ?? ''} ${recipient.email}`.toLowerCase().includes(search.toLowerCase()));
  const bulkRecipients = recipients.slice(0, 200);
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  return (
    <section className={`mail-recipients${value.enabled ? ' is-enabled' : ''}`}>
      <label className="mail-toggle"><input type="checkbox" checked={value.enabled} disabled={disabled || !projectId || !available} onChange={(e) => onChange({ enabled: e.target.checked, recipientIds: [] })} /><span>{t('mail.notify')}</span></label>
      {!status && !statusError && <p className="mail-hint" role="status">{t('mail.checking')}</p>}
      {statusError && <div className="mail-inline-error" role="alert"><span>{statusError}</span><button type="button" disabled={disabled} onClick={() => setStatusRetry((n) => n + 1)}>{t('ann.retry')}</button></div>}
      {status && !available && <p className="mail-hint">{t('mail.unavailable')} {isAdmin && <Link to="/mail">{t('mail.configure')}</Link>} <button type="button" className="mail-text-button" disabled={disabled} onClick={() => setStatusRetry((n) => n + 1)}>{t('mail.refresh')}</button></p>}
      {available && !projectId && <p className="mail-hint">{t('ann.selectProjectFirst')}</p>}
      {value.enabled && <div className="mail-recipient-picker">
        <p className="mail-hint">{t('mail.recipientHint')}</p>
        {loading && <p className="mail-hint" role="status">{t('common.loading')}</p>}
        {error && <div className="mail-inline-error" role="alert"><span>{error}</span><button type="button" disabled={disabled} onClick={() => setRetry((n) => n + 1)}>{t('ann.retry')}</button></div>}
        {loadedProjectId === projectId && !loading && !error && <>
          <div className="mail-recipient-toolbar"><span>{t('mail.selectedCount', { count: selected.size, total: recipients.length })}</span><div><button type="button" disabled={disabled || !recipients.length || (selected.size === bulkRecipients.length && bulkRecipients.every((recipient) => selected.has(recipient.id)))} onClick={() => onChange({ enabled: true, recipientIds: bulkRecipients.map((recipient) => recipient.id) })}>{t(recipients.length > 200 ? 'mail.selectFirst' : 'mail.selectAll')}</button><button type="button" disabled={disabled || !selected.size} onClick={() => onChange({ enabled: true, recipientIds: [] })}>{t('mail.clearAll')}</button></div></div>
          {recipients.length > 200 && <p className="mail-hint">{t('mail.largeRecipientList')}</p>}
          {recipients.length > 6 && <input className="mail-recipient-search" aria-label={t('mail.searchRecipients')} placeholder={t('mail.searchRecipients')} value={search} onChange={(e) => setSearch(e.target.value)} disabled={disabled} />}
          <div className="mail-recipient-list" role="group" aria-label={t('mail.recipients')}>
            {filtered.map((recipient) => <label className="mail-recipient-row" key={recipient.id}><input type="checkbox" aria-label={recipient.displayName ? `${recipient.displayName} (${recipient.email})` : recipient.email} checked={selected.has(recipient.id)} disabled={disabled || (!selected.has(recipient.id) && selected.size >= 200)} onChange={(e) => onChange({ enabled: true, recipientIds: e.target.checked ? [...value.recipientIds, recipient.id] : value.recipientIds.filter((id) => id !== recipient.id) })} /><span><strong>{recipient.displayName || recipient.email}</strong>{recipient.displayName && <small>{recipient.email}</small>}</span></label>)}
            {!filtered.length && <p className="mail-hint">{t(recipients.length ? 'mail.noMatch' : 'mail.noRecipients')}</p>}
          </div>
          {selected.size === 0 && recipients.length > 0 && <p className="mail-selection-hint">{t('mail.chooseRecipients')}</p>}
          {selected.size > 200 && <p className="error" role="alert">{t('mail.recipientLimit')}</p>}
        </>}
      </div>}
    </section>
  );
}
