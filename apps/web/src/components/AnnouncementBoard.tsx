import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Announcement, Project } from '@qota/shared';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useAnnouncementMail } from '../lib/announcement-mail';
import MailRecipients, { emptyMailSelection } from './MailRecipients';
import './announcements.css';

type PublishableProject = { id: number; name: string; customerName: string };

export default function AnnouncementBoard({
  projectId,
  refreshKey,
  onPublishPermissionChange,
}: {
  projectId?: number;
  refreshKey?: number | string;
  onPublishPermissionChange?: (allowed: boolean) => void;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<Announcement[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [publishableProjects, setPublishableProjects] = useState<PublishableProject[]>([]);
  const [filter, setFilter] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [editor, setEditor] = useState<{ item?: Announcement; projectId?: number } | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const generation = useRef(0);
  const moreRequest = useRef<number | null>(null);
  const deleteBusy = useRef(false);
  const previousFilter = useRef<number | undefined>();
  const mailDelivery = useAnnouncementMail(items, setItems, t('mail.noProgress'));
  const selectedProjectId = projectId ?? (filter ? Number(filter) : undefined);
  const limit = projectId === undefined ? 20 : 3;
  const availableProjects = projectId === undefined
    ? publishableProjects
    : publishableProjects.filter((project) => project.id === projectId);

  useEffect(() => {
    onPublishPermissionChange?.(false);
    setPublishableProjects([]);
    setEditor(null);
  }, [projectId, onPublishPermissionChange]);

  useEffect(() => {
    if (projectId !== undefined) return;
    let active = true;
    void api.listProjects().then((value) => { if (active) setProjects(value); }).catch(() => {});
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    const requestId = ++generation.current;
    moreRequest.current = null;
    setLoadingMore(false);
    setLoading(true);
    setError(null);
    if (previousFilter.current !== selectedProjectId) setItems([]);
    previousFilter.current = selectedProjectId;
    void api.listAnnouncements({ projectId: selectedProjectId, limit }).then((result) => {
      if (generation.current !== requestId) return;
      setItems(result.items);
      setNextCursor(result.nextCursor);
      setPublishableProjects(result.publishableProjects);
      onPublishPermissionChange?.(projectId === undefined
        ? result.publishableProjects.length > 0
        : result.publishableProjects.some((project) => project.id === projectId));
    }).catch((e: any) => {
      if (generation.current !== requestId) return;
      setError(e?.message ?? String(e));
      setPublishableProjects([]);
      onPublishPermissionChange?.(false);
    }).finally(() => {
      if (generation.current === requestId) setLoading(false);
    });
    return () => { generation.current++; };
  }, [selectedProjectId, projectId, refreshKey, reload, limit, onPublishPermissionChange]);

  async function loadMore() {
    if (!nextCursor || loading || moreRequest.current !== null) return;
    const requestId = generation.current;
    moreRequest.current = requestId;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await api.listAnnouncements({ projectId: selectedProjectId, cursor: nextCursor, limit });
      if (generation.current !== requestId) return;
      setItems((current) => {
        const ids = new Set(current.map((item) => item.id));
        return [...current, ...result.items.filter((item) => !ids.has(item.id))];
      });
      setNextCursor(result.nextCursor);
      setPublishableProjects(result.publishableProjects);
    } catch (e: any) {
      if (generation.current === requestId) setError(e?.message ?? String(e));
    } finally {
      if (moreRequest.current === requestId) {
        moreRequest.current = null;
        setLoadingMore(false);
      }
    }
  }

  async function remove(item: Announcement) {
    if (deleteBusy.current || !confirm(t('ann.confirmDelete'))) return;
    deleteBusy.current = true;
    setDeletingId(item.id);
    setError(null);
    try {
      await api.deleteAnnouncement(item.id);
      setItems((current) => current.filter((entry) => entry.id !== item.id));
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      deleteBusy.current = false;
      setDeletingId(null);
    }
  }

  return (
    <section className={`announcement-board${projectId !== undefined ? ' announcement-board-project' : ''}`} aria-busy={loading}>
      <div className="announcement-board-toolbar">
        <div className="announcement-board-label">
          <AnnouncementIcon />
          <h3>{t(projectId === undefined ? 'ann.latest' : 'ann.projectTitle')}</h3>
        </div>
        <div className="announcement-board-controls">
          {projectId === undefined && projects.length > 0 && (
            <select aria-label={t('ann.filterProject')} value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">{t('ann.allProjects')}</option>
              {projects.map((project) => <option value={project.id} key={project.id}>{project.name} ({project.code})</option>)}
            </select>
          )}
          {availableProjects.length > 0 && (
            <button className="primary" type="button" onClick={() => setEditor({ projectId: selectedProjectId })}>
              {t('ann.publish')}
            </button>
          )}
        </div>
      </div>
      {error && <div className="announcement-error" role="alert"><span>{error}</span><button type="button" onClick={() => setReload((value) => value + 1)}>{t('ann.retry')}</button></div>}
      {loading && !items.length ? <div className="announcement-loading" role="status">{t('common.loading')}</div> : (
        <div className="announcement-feed">
          {items.map((item) => (
            <AnnouncementCard
              key={item.id}
              item={item}
              compact={projectId !== undefined}
              busy={deletingId !== null}
              onEdit={() => setEditor({ item })}
              onDelete={() => void remove(item)}
              mailSending={mailDelivery.sendingId === item.id}
              mailBusy={mailDelivery.sendingId !== null}
              mailError={mailDelivery.errors[item.id]}
              onRetryMail={() => mailDelivery.retry(item)}
            />
          ))}
          {!items.length && !error && <div className="announcement-empty"><AnnouncementIcon /><strong>{t('ann.empty')}</strong><p>{t('ann.emptyHint')}</p></div>}
        </div>
      )}
      {nextCursor && items.length > 0 && <div className="announcement-more"><button type="button" disabled={loading || loadingMore} onClick={loadMore}>{t(loadingMore ? 'common.loading' : 'ann.loadMore')}</button></div>}
      {editor && (
        <AnnouncementEditor
          item={editor.item}
          initialProjectId={editor.projectId}
          fixedProjectId={projectId}
          projects={availableProjects}
          onClose={() => setEditor(null)}
          onSaved={(item) => {
            if (editor.item) setItems((current) => current.map((entry) => entry.id === item.id ? item : entry));
            else if (projectId === undefined && filter && Number(filter) !== item.projectId) setFilter(String(item.projectId));
            else setReload((value) => value + 1);
            setEditor(null);
          }}
        />
      )}
    </section>
  );
}

function AnnouncementCard({ item, compact, busy, onEdit, onDelete, mailSending, mailBusy, mailError, onRetryMail }: {
  item: Announcement;
  compact: boolean;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  mailSending: boolean;
  mailBusy: boolean;
  mailError?: string;
  onRetryMail: () => void;
}) {
  const { t } = useI18n();
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element || expanded) return;
    const check = () => setTruncated(element.scrollHeight > element.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [item.content, expanded, compact]);

  return (
    <article className="announcement-card" data-announcement-id={item.id}>
      <div className="announcement-card-header">
        <div className="announcement-origin">
          {!compact && <Link to={`/projects/${item.projectId}`} className="announcement-project" title={`${item.customerName} / ${item.projectName}`}><span>{item.customerName}</span><span aria-hidden="true">/</span><strong>{item.projectName}</strong></Link>}
          <span className={`announcement-source${item.version ? ' announcement-source-version' : ''}`}>{item.version ? t('ann.versionSource', { version: item.version }) : t('ann.manualSource')}</span>
        </div>
        <time className="announcement-time" dateTime={new Date(item.createdAt).toISOString()} title={new Date(item.createdAt).toLocaleString()}>{new Date(item.createdAt).toLocaleDateString()} {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
      </div>
      <div ref={contentRef} className={`announcement-content${expanded ? ' is-expanded' : ''}${compact ? ' is-compact' : ''}`} id={`announcement-content-${item.id}`} tabIndex={expanded ? 0 : undefined}>{item.content}</div>
      {(item.mail?.total ?? 0) > 0 && <div className={`announcement-mail${item.mail.failed ? ' is-failed' : ''}`} aria-live="polite">
        <span>{t('mail.sentCount', { sent: item.mail.sent, total: item.mail.total })}</span>
        {item.mail.pending > 0 && <span>{t(mailSending ? 'mail.sendingCount' : 'mail.pendingCount', { count: item.mail.pending })}</span>}
        {item.mail.failed > 0 && <span className="mail-failed">{t('mail.failedCount', { count: item.mail.failed })}</span>}
        {item.mail.skipped > 0 && <span>{t('mail.skippedCount', { count: item.mail.skipped })}</span>}
        {item.canEdit && (item.mail.failed > 0 || item.mail.pending > 0) && <button type="button" disabled={busy || mailBusy} onClick={onRetryMail}>{t(mailSending ? 'mail.sending' : item.mail.failed > 0 ? 'mail.retryFailed' : 'mail.continue')}</button>}
        {mailError && <p className="announcement-mail-error" role="alert">{mailError}</p>}
      </div>}
      <div className="announcement-card-footer">
        <div className="announcement-author"><span className="announcement-author-dot" aria-hidden="true">{(item.authorName || '?').slice(0, 1)}</span><span>{item.authorName || t('ann.unknownAuthor')}</span>{item.updatedAt > item.createdAt && <span className="announcement-edited" title={new Date(item.updatedAt).toLocaleString()}>{t('ann.edited')}</span>}</div>
        <div className="announcement-card-actions">
          {(truncated || expanded) && <button type="button" aria-expanded={expanded} aria-controls={`announcement-content-${item.id}`} onClick={() => setExpanded((value) => !value)}>{t(expanded ? 'ann.collapse' : 'ann.expand')}</button>}
          {item.canEdit && <button type="button" disabled={busy} onClick={onEdit}>{t('ann.edit')}</button>}
          {item.canDelete && <button type="button" className="announcement-delete" disabled={busy} onClick={onDelete}>{t('common.delete')}</button>}
        </div>
      </div>
    </article>
  );
}

function AnnouncementEditor({ item, initialProjectId, fixedProjectId, projects, onClose, onSaved }: {
  item?: Announcement;
  initialProjectId?: number;
  fixedProjectId?: number;
  projects: PublishableProject[];
  onClose: () => void;
  onSaved: (item: Announcement) => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const [projectId, setProjectId] = useState(item?.projectId ?? fixedProjectId ?? (projects.some((project) => project.id === initialProjectId) ? initialProjectId : projects.length === 1 ? projects[0]!.id : undefined));
  const [selectedVersion, setSelectedVersion] = useState<string | null | undefined>(undefined);
  const [versionOptions, setVersionOptions] = useState<{ label: string; isCurrent: boolean; archived: boolean }[]>([]);
  const [versionsProjectId, setVersionsProjectId] = useState<number | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [versionsRetry, setVersionsRetry] = useState(0);
  const [mailSelection, setMailSelection] = useState(emptyMailSelection);
  const [mailReady, setMailReady] = useState(true);
  const [content, setContent] = useState(item?.content ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectName = item?.projectName ?? projects.find((project) => project.id === projectId)?.name;
  const versionsReady = Boolean(item) || (versionsProjectId === projectId && !versionsLoading && !versionsError && selectedVersion !== undefined);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    if (item) return;
    let active = true;
    setSelectedVersion(undefined);
    setVersionOptions([]);
    setVersionsProjectId(null);
    setVersionsError(null);
    setVersionsLoading(Boolean(projectId));
    if (!projectId) return;
    void api.listVersions(projectId).then((files) => {
      if (!active) return;
      const labels = new Map<string, { label: string; isCurrent: boolean; archived: boolean }>();
      for (const file of files) {
        if (file.status !== 'ready' && file.status !== 'archived') continue;
        const label = labels.get(file.version);
        if (label) {
          label.isCurrent ||= file.isCurrent;
          label.archived &&= file.status === 'archived';
        } else {
          labels.set(file.version, { label: file.version, isCurrent: file.isCurrent, archived: file.status === 'archived' });
        }
      }
      setVersionOptions([...labels.values()]);
      setVersionsProjectId(projectId);
    }).catch((e: any) => {
      if (active) setVersionsError(e?.message ?? String(e));
    }).finally(() => {
      if (active) setVersionsLoading(false);
    });
    return () => { active = false; };
  }, [item, projectId, versionsRetry]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busyRef.current || !projectId || !content.trim() || !versionsReady || (!item && (!mailReady || (mailSelection.enabled && !mailSelection.recipientIds.length)))) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const updated = item
        ? await api.updateAnnouncement(item.id, { content: content.trim() })
        : await api.createAnnouncement({ projectId, version: selectedVersion ?? null, content: content.trim(), recipientIds: mailSelection.enabled ? mailSelection.recipientIds : undefined });
      onSaved(updated);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialogRef} className="dialog announcement-editor" aria-labelledby="announcement-editor-title" onCancel={(e) => { e.preventDefault(); if (!busyRef.current) onClose(); }}>
      <form onSubmit={save}>
        <div className="announcement-editor-heading"><h3 id="announcement-editor-title">{t(item ? 'ann.editTitle' : 'ann.publishTitle')}</h3><button type="button" disabled={busy} onClick={onClose}>{t('common.close')}</button></div>
        <p className="announcement-editor-hint">{t('ann.visibilityHint')}</p>
        {!item && fixedProjectId === undefined ? (
          <label><span className="lbl">{t('ann.project')}</span><select aria-label={t('ann.project')} value={projectId ?? ''} onChange={(e) => { setProjectId(Number(e.target.value)); setSelectedVersion(undefined); setMailSelection(emptyMailSelection()); setMailReady(true); setError(null); }} required disabled={busy}><option value="" disabled>{t('common.select')}</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.customerName} / {project.name}</option>)}</select></label>
        ) : <div className="announcement-editor-context"><span>{projectName}</span>{item?.version && <span className="announcement-source announcement-source-version">{t('ann.versionSource', { version: item.version })}</span>}</div>}
        {!item && <div className="announcement-version-field">
          <label>
            <span className="lbl">{t('ann.version')}</span>
            <select
              aria-label={t('ann.version')}
              aria-describedby="announcement-version-hint"
              value={selectedVersion === undefined ? '' : selectedVersion === null ? 'project' : JSON.stringify(selectedVersion)}
              onChange={(e) => setSelectedVersion(e.target.value === 'project' ? null : JSON.parse(e.target.value))}
              required
              disabled={busy || !projectId || versionsLoading || versionsProjectId !== projectId || Boolean(versionsError)}
            >
              <option value="" disabled>{t('ann.versionPlaceholder')}</option>
              <option value="project">{t('ann.noVersion')}</option>
              {versionOptions.map((version) => <option key={version.label} value={JSON.stringify(version.label)}>{version.label}{version.isCurrent ? ` · ${t('pd.currentTag')}` : ''}{version.archived ? ` · ${t('status.archived')}` : ''}</option>)}
            </select>
          </label>
          {versionsError ? <div id="announcement-version-hint" className="announcement-version-error" role="alert"><span>{t('ann.versionsLoadFailed')} {versionsError}</span><button type="button" disabled={busy} onClick={() => setVersionsRetry((value) => value + 1)}>{t('ann.retry')}</button></div> : (
            <p id="announcement-version-hint" className="announcement-version-hint" role="status">{t(!projectId ? 'ann.selectProjectFirst' : versionsLoading || versionsProjectId !== projectId ? 'ann.versionsLoading' : !versionOptions.length ? 'ann.noProjectVersions' : 'ann.versionHint')}</p>
          )}
        </div>}
        <label><span className="lbl">{t('ann.content')}</span><textarea aria-label={t('ann.content')} value={content} onChange={(e) => setContent(e.target.value)} rows={9} maxLength={10000} required disabled={busy} autoFocus placeholder={t('ann.contentPlaceholder')} /></label>
        <div className="announcement-editor-count">{content.length.toLocaleString()} / 10,000</div>
        {!item ? <MailRecipients projectId={projectId} value={mailSelection} onChange={setMailSelection} onReadyChange={setMailReady} disabled={busy} /> : <p className="announcement-mail-edit-hint">{t('mail.editHint')}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>{t('common.cancel')}</button><button type="submit" className="primary" disabled={busy || !projectId || !content.trim() || !versionsReady || (!item && (!mailReady || (mailSelection.enabled && !mailSelection.recipientIds.length)))}>{t(busy ? 'ann.saving' : item ? 'common.save' : 'ann.publishSubmit')}</button></div>
      </form>
    </dialog>
  );
}

function AnnouncementIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 10v6h4l10 4V6L8 10H4Zm4 6 2 5h3l-1-4M21 10v6" /></svg>;
}
