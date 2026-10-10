import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../lib/api';
import { startUpload, type UploadJobHandle } from '../lib/upload';
import { formatBytes } from '../lib/utils';
import { useI18n } from '../lib/i18n';
import { customerHierarchy } from '../lib/customer-tree';
import VersionNotesPreview from '../components/VersionNotesPreview';
import AnnouncementBoard from '../components/AnnouncementBoard';
import MailRecipients, { emptyMailSelection } from '../components/MailRecipients';
import type { ApiToken, Project, Version } from '@qota/shared';

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const projectId = Number(id);
  const activeProjectId = useRef(projectId);
  activeProjectId.current = projectId;
  const loadGeneration = useRef(0);
  const { t } = useI18n();
  const [project, setProject] = useState<Project | null>(null);
  const [customerPath, setCustomerPath] = useState('');
  const [versions, setVersions] = useState<Version[]>([]);
  const [expandedVersionGroups, setExpandedVersionGroups] = useState<Set<string>>(() => new Set());
  const [notesDialog, setNotesDialog] = useState<{ version: string; items: Version[]; scope: 'version' | 'file' } | null>(null);
  const [specialVersionDialog, setSpecialVersionDialog] = useState<string | null>(null);
  const [announcementRefresh, setAnnouncementRefresh] = useState(0);
  const [canPublishAnnouncements, setCanPublishAnnouncements] = useState(false);
  const [versionBusy, setVersionBusy] = useState(false);
  const versionBusyRef = useRef(false);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [err, setErr] = useState<string | null>(null);

  // upload state
  const [showUpload, setShowUpload] = useState(false);

  // token state
  const [showTokenDlg, setShowTokenDlg] = useState(false);
  const [tokName, setTokName] = useState('');
  const [tokKind, setTokKind] = useState<'device' | 'ci'>('device');
  const [tokScope, setTokScope] = useState<'download' | 'upload' | 'full'>('download');
  const [tokChannel, setTokChannel] = useState('');
  const [tokSpecialVersion, setTokSpecialVersion] = useState('');
  const [tokVersion, setTokVersion] = useState('');
  const [tokVersionId, setTokVersionId] = useState<number | null>(null);
  const [tokBusy, setTokBusy] = useState(false);
  const tokBusyRef = useRef(false);
  const tokRequestGeneration = useRef(0);
  const tokDialogRef = useRef<HTMLDialogElement>(null);
  const [tokError, setTokError] = useState<string | null>(null);
  const [tokFileCleared, setTokFileCleared] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [copiedTokenId, setCopiedTokenId] = useState<number | null>(null);

  // public-access state — the version whose public dialog is open
  const [publicVer, setPublicVer] = useState<Version | null>(null);
  const [publicBusy, setPublicBusy] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  // Channels available for this project: the project default + every channel
  // already used by a version. New ones are created inline in the dialogs.
  const channelList = useMemo(() => {
    const set = new Set<string>();
    set.add(project?.defaultChannel || 'stable');
    for (const v of versions) set.add(v.releaseChannel);
    return [...set].sort();
  }, [project, versions]);

  const versionList = useMemo(() => {
    const set = new Set<string>();
    for (const v of versions) set.add(v.version);
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  }, [versions]);

  const specialVersionList = useMemo(() => [...new Set(versions.map((v) => v.specialVersion).filter((value): value is string => !!value))].sort(), [versions]);

  const tokenFiles = useMemo(() => versions.filter((v) => v.status === 'ready' || v.status === 'archived'), [versions]);
  const tokenVersionOptions = useMemo(() => [...new Set(tokenFiles.map((v) => v.version))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [tokenFiles]);
  const tokenSpecialOptions = useMemo(() => [...new Set(tokenFiles.map((v) => v.specialVersion).filter((value): value is string => !!value))].sort(), [tokenFiles]);
  const tokenFileOptions = useMemo(() => tokenFiles.filter((v) => (!tokChannel || v.releaseChannel === tokChannel)
    && (!tokSpecialVersion || v.specialVersion === tokSpecialVersion) && (!tokVersion || v.version === tokVersion)), [tokenFiles, tokChannel, tokSpecialVersion, tokVersion]);
  const tokenMatchingFiles = tokVersionId === null ? tokenFileOptions : tokenFileOptions.filter((v) => v.id === tokVersionId);
  const tokenHasVersionRestriction = !!tokSpecialVersion || !!tokVersion || tokVersionId !== null;
  const tokenRangeValid = !tokenHasVersionRestriction || tokenMatchingFiles.length > 0;
  const selectedTokenFile = tokenFiles.find((v) => v.id === tokVersionId);

  useEffect(() => {
    if (!showTokenDlg) return;
    const dialog = tokDialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, [showTokenDlg]);

  function changeTokenRestriction(field: 'channel' | 'specialVersion' | 'version', value: string) {
    const channel = field === 'channel' ? value : tokChannel;
    const specialVersion = field === 'specialVersion' ? value : tokSpecialVersion;
    const version = field === 'version' ? value : tokVersion;
    if (field === 'channel') setTokChannel(value);
    if (field === 'specialVersion') setTokSpecialVersion(value);
    if (field === 'version') setTokVersion(value);
    if (tokVersionId !== null && !tokenFiles.some((v) => v.id === tokVersionId && (!channel || v.releaseChannel === channel)
      && (!specialVersion || v.specialVersion === specialVersion) && (!version || v.version === version))) {
      setTokVersionId(null);
      setTokFileCleared(true);
    }
    setTokError(null);
  }

  const versionGroups = useMemo(
    () => groupVersions(versions.filter((v) => v.status !== 'archived')),
    [versions],
  );
  const archivedGroups = useMemo(
    () => groupVersions(versions.filter((v) => v.status === 'archived')),
    [versions],
  );

  async function load() {
    if (activeProjectId.current !== projectId) return;
    const requestGeneration = ++loadGeneration.current;
    const isCurrentRequest = () => activeProjectId.current === projectId && loadGeneration.current === requestGeneration;
    try {
      const [p, customers] = await Promise.all([api.getProject(projectId), api.listCustomers()]);
      if (!isCurrentRequest()) return;
      setProject(p);
      setCustomerPath(customerHierarchy(customers).paths.get(p.customerId) ?? '');
      const [v, tk] = await Promise.all([
        api.listVersions(projectId),
        api.listApiTokens(projectId).catch(() => [] as ApiToken[]),
      ]);
      if (!isCurrentRequest()) return;
      setVersions(v);
      setTokens(tk);
      setAnnouncementRefresh((value) => value + 1);
    } catch (e: any) {
      if (isCurrentRequest()) setErr(e?.message);
    }
  }

  useEffect(() => {
    tokRequestGeneration.current++;
    tokBusyRef.current = false;
    setTokBusy(false);
    setShowTokenDlg(false);
    setNewToken(null);
    setTokName('');
    setTokKind('device');
    setTokScope('download');
    setTokChannel('');
    setTokSpecialVersion('');
    setTokVersion('');
    setTokVersionId(null);
    setTokError(null);
    setTokFileCleared(false);
    setTokenCopied(false);
    setCopiedTokenId(null);
    setProject(null);
    setCustomerPath('');
    setVersions([]);
    setTokens([]);
    setErr(null);
    setCanPublishAnnouncements(false);
    if (Number.isFinite(projectId)) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);


  async function download(v: Version) {
    try {
      const grant = await api.grantDownload(v.id);
      const a = document.createElement('a');
      a.href = grant.url;
      a.download = grant.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e: any) {
      setErr(e?.message);
    }
  }

  function publicUrlFor(slug: string) {
    return `${window.location.origin}/api/public/download/${slug}`;
  }

  function openPublic(v: Version) {
    setPublicVer(v);
    setLinkCopied(false);
  }

  function patchVersion(id: number, patch: Partial<Version>) {
    setVersions((vs) => vs.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    setPublicVer((pv) => (pv && pv.id === id ? { ...pv, ...patch } : pv));
  }

  function toggleVersionGroup(versionLabel: string) {
    setExpandedVersionGroups((cur) => {
      const next = new Set(cur);
      if (next.has(versionLabel)) next.delete(versionLabel);
      else next.add(versionLabel);
      return next;
    });
  }

  async function enablePublic() {
    if (!publicVer) return;
    setErr(null);
    setPublicBusy(true);
    try {
      const { publicSlug } = await api.enableVersionPublic(publicVer.id);
      patchVersion(publicVer.id, { publicSlug });
    } catch (e: any) {
      setErr(e?.message);
    } finally {
      setPublicBusy(false);
    }
  }

  async function disablePublic() {
    if (!publicVer) return;
    if (!confirm(t('pd.confirmDisablePublic'))) return;
    setErr(null);
    setPublicBusy(true);
    try {
      await api.disableVersionPublic(publicVer.id);
      patchVersion(publicVer.id, { publicSlug: null });
    } catch (e: any) {
      setErr(e?.message);
    } finally {
      setPublicBusy(false);
    }
  }

  async function copyPublicLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1500);
    } catch {
      /* clipboard blocked — the link above is select-all to copy by hand */
    }
  }

  async function mutateVersions(mutation: () => Promise<unknown>) {
    if (versionBusyRef.current) return;
    versionBusyRef.current = true;
    setVersionBusy(true);
    setErr(null);
    try {
      await mutation();
      await load();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      versionBusyRef.current = false;
      setVersionBusy(false);
    }
  }

  async function deleteVer(v: Version) {
    if (!confirm(t('pd.confirmDeleteVer', { version: v.version, channel: v.releaseChannel }))) return;
    await mutateVersions(() => api.deleteVersion(v.id));
  }

  async function archiveVer(v: Version) {
    await mutateVersions(() => api.updateVersion(v.id, { status: 'archived' }));
  }

  async function restoreVer(v: Version) {
    await mutateVersions(() => api.updateVersion(v.id, { status: 'ready' }));
  }

  async function setCurrentVersion(versionLabel: string, isCurrent: boolean) {
    await mutateVersions(() => api.updateVersionGroup({ projectId, version: versionLabel, isCurrent }));
  }

  async function setGroupStatus(versionLabel: string, status: 'ready' | 'archived') {
    await mutateVersions(() => api.updateVersionGroup({ projectId, version: versionLabel, status }));
  }

  async function createToken(e: FormEvent) {
    e.preventDefault();
    if (tokBusyRef.current || newToken || !tokName.trim()) return;
    if (!tokenRangeValid) { setTokError(t('pd.tokenNoMatches')); return; }
    tokBusyRef.current = true;
    const requestGeneration = ++tokRequestGeneration.current;
    const isCurrentRequest = () => activeProjectId.current === projectId && tokRequestGeneration.current === requestGeneration;
    setTokBusy(true);
    setTokError(null);
    try {
      const tk = await api.createApiToken({
        projectId,
        name: tokName.trim(),
        kind: tokKind,
        scope: tokKind === 'device' ? 'download' : tokScope,
        channel: tokChannel || null,
        specialVersion: tokSpecialVersion || null,
        version: tokVersion || null,
        versionId: tokVersionId,
      });
      if (!isCurrentRequest()) return;
      setNewToken(tk.token);
      setTokName('');
      setTokChannel('');
      setTokSpecialVersion('');
      setTokVersion('');
      setTokVersionId(null);
      await load();
    } catch (e: any) {
      if (isCurrentRequest()) setTokError(e?.message ?? String(e));
    } finally {
      if (isCurrentRequest()) {
        tokBusyRef.current = false;
        setTokBusy(false);
      }
    }
  }

  async function revokeToken(tk: ApiToken) {
    if (!confirm(t('pd.confirmRevoke', { name: tk.name }))) return;
    try {
      await api.revokeApiToken(tk.id);
      await load();
    } catch (e: any) {
      setErr(e?.message);
    }
  }

  async function deleteToken(tk: ApiToken) {
    if (!confirm(t('pd.confirmDeleteToken', { name: tk.name }))) return;
    try {
      await api.deleteApiToken(tk.id);
      await load();
    } catch (e: any) {
      setErr(e?.message);
    }
  }

  async function copyTokenSecret(tk: ApiToken) {
    setErr(null);
    const requestGeneration = tokRequestGeneration.current;
    const isCurrentRequest = () => activeProjectId.current === projectId && tokRequestGeneration.current === requestGeneration;
    let token: string;
    try {
      ({ token } = await api.revealApiToken(tk.id));
    } catch (e: any) {
      if (isCurrentRequest()) setErr(e?.message);
      return;
    }
    if (!isCurrentRequest()) return;
    try {
      await navigator.clipboard.writeText(token);
      if (!isCurrentRequest()) return;
      setCopiedTokenId(tk.id);
      setTimeout(() => setCopiedTokenId((id) => (id === tk.id ? null : id)), 1500);
    } catch {
      if (!isCurrentRequest()) return;
      // Clipboard blocked (no gesture / insecure context) — show the token in the
      // dialog (select-all) so it can still be copied by hand.
      setNewToken(token);
      setShowTokenDlg(true);
    }
  }

  if (!project) {
    return (
      <>
        <h2 className="page-title">{t('pd.project')}</h2>
        {err && <div className="error">{err}</div>}
        {!err && <div className="muted">{t('common.loading')}</div>}
      </>
    );
  }

  const publicUrl = publicVer?.publicSlug ? publicUrlFor(publicVer.publicSlug) : null;
  const renderChannelTag = (releaseChannel: string) => (
    <span className={`tag ${releaseChannel === 'stable' ? 'stable' : releaseChannel === 'beta' ? 'beta' : ''}`} title={releaseChannel}>
      {releaseChannel}
    </span>
  );
  const statusSummary = (statusCounts: Map<Version['status'], number>) =>
    [...statusCounts.entries()]
      .map(([status, count]) => `${t(`status.${status}`)}${count > 1 ? ` x${count}` : ''}`)
      .join(' / ');
  const renderNotes = (items: Version[], scope: 'version' | 'file' = 'file') => {
    const first = items[0]!;
    const preview = scope === 'version' ? first.versionNotes : first.notes;
    const versionLabel = first.version;
    const label = t(scope === 'version' ? 'pd.viewVersionNotes' : 'pd.viewFileNotes', {
      version: versionLabel, filename: first.filename, channel: first.releaseChannel,
    });
    return (
      <VersionNotesPreview
        text={preview}
        label={label}
        icon={<VersionIcon name="notes" />}
        onClick={() => {
          setNotesDialog({ version: versionLabel, items, scope });
        }}
      />
    );
  };
  const renderVersionActions = (v: Version, showCurrentAction = true) => (
    <div className="version-row-actions">
      {showCurrentAction && v.status === 'ready' && (
        <button
          className={`version-current-action${v.isCurrent ? ' is-active' : ''}`}
          onClick={() => setCurrentVersion(v.version, !v.isCurrent)}
          disabled={versionBusy}
          aria-pressed={v.isCurrent}
        >
          {v.isCurrent ? t('pd.unsetCurrent') : t('pd.setCurrent')}
        </button>
      )}
      {v.status === 'ready' && (
        <button onClick={() => archiveVer(v)} disabled={versionBusy}>
          {t('pd.archive')}
        </button>
      )}
      {v.status === 'archived' && (
        <button onClick={() => restoreVer(v)} disabled={versionBusy}>
          {t('pd.restore')}
        </button>
      )}
      <span className="version-action-divider" aria-hidden="true" />
      <button
        className="version-icon-button"
        onClick={() => download(v)}
        disabled={v.status !== 'ready'}
        title={t('pd.download')}
        aria-label={t('pd.download')}
      >
        <VersionIcon name="download" />
      </button>
      <button
        onClick={() => openPublic(v)}
        disabled={v.status !== 'ready' && !v.publicSlug}
        className={`version-icon-button${v.publicSlug ? ' is-public' : ''}`}
        title={t('pd.dlgPublic')}
        aria-label={t('pd.public')}
      >
        <VersionIcon name="public" />
      </button>
      <button
        className="version-icon-button version-delete-action"
        onClick={() => deleteVer(v)}
        disabled={versionBusy}
        title={t('common.delete')}
        aria-label={t('common.delete')}
      >
        <VersionIcon name="delete" />
      </button>
    </div>
  );
  const renderUploadTime = (timestamp: number) => (
    <time className="version-upload-time" dateTime={new Date(timestamp).toISOString()}>
      <span>{new Date(timestamp).toLocaleDateString()}</span>
      <span>{new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
    </time>
  );
  const renderVersionRow = (v: Version, grouped = false) => (
    <tr key={v.id} className={grouped ? 'version-detail-row' : undefined}>
      <td>
        <div className="version-identity">
          <span className="version-label" title={v.version}>{v.version}</span>
          {(v.isCurrent || v.publicSlug) && (
            <span className="version-meta">
              {v.isCurrent && <span className="tag current">{t('pd.currentTag')}</span>}
              {v.publicSlug && <span className="version-public-label">{t('pd.publicTag')}</span>}
            </span>
          )}
        </div>
      </td>
      <td><span className="version-special-label" title={v.specialVersion ?? ''}>{v.specialVersion ?? ''}</span></td>
      <td className="version-notes-cell">{renderNotes([v])}</td>
      <td>{renderChannelTag(v.releaseChannel)}</td>
      <td>
        <span className={`tag ${v.status === 'ready' ? 'stable' : ''}`}>{t(`status.${v.status}`)}</span>
      </td>
      <td>{formatBytes(v.size)}</td>
      <td><span className="version-filename" title={v.filename}>{v.filename}</span></td>
      <td>{renderUploadTime(v.createdAt)}</td>
      <td>
        <span className="version-checksum" title={v.sha256 ?? ''}>
          {v.sha256 ? `${v.sha256.slice(0, 12)}...` : '-'}
        </span>
      </td>
      <td>{v.downloadCount}</td>
      <td className="version-actions-cell">{renderVersionActions(v, !grouped)}</td>
    </tr>
  );

  const renderVersionsTable = (groups: ReturnType<typeof groupVersions>, archived = false) => (
    <div className="version-table-scroll">
      <table className="version-table">
        <colgroup>
          <col style={{ width: 184 }} />
          <col style={{ width: 144 }} />
          <col style={{ width: 204 }} />
          <col style={{ width: 140 }} />
          <col style={{ width: 90 }} />
          <col style={{ width: 92 }} />
          <col style={{ width: 150 }} />
          <col style={{ width: 116 }} />
          <col style={{ width: 108 }} />
          <col style={{ width: 76 }} />
          <col style={{ width: 300 }} />
        </colgroup>
        <thead>
          <tr>
            <th>{t('pd.colVersion')}</th>
            <th>{t('pd.specialVersion')}</th>
            <th className="version-notes-cell">{t('pd.colNotes')}</th>
            <th>{t('pd.colChannel')}</th>
            <th>{t('pd.colStatus')}</th>
            <th>{t('pd.colSize')}</th>
            <th>{t('pd.colFilename')}</th>
            <th>{t('pd.colUploaded')}</th>
            <th>{t('pd.colSha')}</th>
            <th>{t('pd.colDownloads')}</th>
            <th className="version-actions-cell">{t('pd.colActions')}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const [first] = group.items;
            if (!first) return null;

            const groupKey = `${archived ? 'archived' : 'active'}:${group.label}`;
            const expanded = expandedVersionGroups.has(groupKey);
            const onlyStatus = group.statusCounts.size === 1 ? group.latest.status : null;
            return (
              <Fragment key={`group-${group.label}`}>
                <tr className="version-group-row" onClick={() => toggleVersionGroup(groupKey)}>
                  <td>
                    <div className="version-group-main">
                      <button
                        type="button"
                        className={`version-toggle${expanded ? ' is-expanded' : ''}`}
                        title={t(expanded ? 'pd.collapse' : 'pd.expand')}
                        aria-label={`${t(expanded ? 'pd.collapse' : 'pd.expand')} ${group.label}`}
                        aria-expanded={expanded}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleVersionGroup(groupKey);
                        }}
                      >
                        <VersionIcon name="chevron" />
                      </button>
                      <div className="version-identity">
                        <span className="version-label" title={group.label}>{group.label}</span>
                        <span className="version-meta">
                          {group.hasCurrent
                            ? <span className="tag current">{t('pd.currentTag')}</span>
                            : <span>{t('pd.channelCount', { count: group.channels.length })}</span>}
                          {group.hasPublic && <span className="version-public-label">{t('pd.publicTag')}</span>}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="version-special-button"
                      title={first.specialVersion || t('pd.editSpecialVersion', { version: group.label })}
                      aria-label={t('pd.editSpecialVersion', { version: group.label })}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSpecialVersionDialog(group.label);
                      }}
                    >
                      <span className="version-special-label">{first.specialVersion ?? ''}</span>
                      <VersionIcon name="edit" />
                    </button>
                  </td>
                  <td className="version-notes-cell">{renderNotes(group.items, 'version')}</td>
                  <td>
                    <span className="version-channel-list">
                      {group.channels.slice(0, 2).map((ch) => <Fragment key={ch}>{renderChannelTag(ch)}</Fragment>)}
                      {group.channels.length > 2 && <span className="version-channel-more" title={group.channels.slice(2).join(', ')}>+{group.channels.length - 2}</span>}
                    </span>
                  </td>
                  <td>
                    <span className={`tag ${onlyStatus === 'ready' ? 'stable' : ''}`}>
                      {statusSummary(group.statusCounts)}
                    </span>
                  </td>
                  <td>{formatBytes(group.totalSize)}</td>
                  <td>{t('pd.firmwareCount', { count: group.items.length })}</td>
                  <td>{renderUploadTime(group.latest.createdAt)}</td>
                  <td>
                    <span className="muted">-</span>
                  </td>
                  <td>{group.totalDownloads}</td>
                  <td className="version-actions-cell">
                    <div className="version-row-actions" onClick={(e) => e.stopPropagation()}>
                      {group.hasReady && (
                        <>
                          <button
                            type="button"
                            className={`version-current-action${group.hasCurrent ? ' is-active' : ''}`}
                            aria-pressed={group.hasCurrent}
                            onClick={() => setCurrentVersion(group.label, !group.hasCurrent)}
                            disabled={versionBusy}
                          >
                            {group.hasCurrent ? t('pd.unsetCurrent') : t('pd.setCurrent')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setGroupStatus(group.label, 'archived')}
                            disabled={versionBusy}
                          >
                            {t('pd.archive')}
                          </button>
                        </>
                      )}
                      {archived && (
                        <button
                          type="button"
                          onClick={() => setGroupStatus(group.label, 'ready')}
                          disabled={versionBusy}
                        >
                          {t('pd.restore')}
                        </button>
                      )}
                      <button type="button" onClick={() => toggleVersionGroup(groupKey)}>
                        {expanded ? t('pd.collapse') : t('pd.expand')}
                      </button>
                    </div>
                  </td>
                </tr>
                {expanded && group.items.map((v) => renderVersionRow(v, true))}
              </Fragment>
            );
          })}
          {groups.length === 0 && (
            <tr>
              <td colSpan={11} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                {t(archived ? 'pd.noArchives' : 'pd.noVersions')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <h2 className="page-title project-detail-title">
        {customerPath ? `${customerPath}-${project.name}` : project.name}{' '}
        <span className="muted code" style={{ fontSize: 13 }}>
          {project.code}
        </span>
      </h2>
      {err && (
        <div className="error" style={{ marginBottom: 12 }}>
          {err}
        </div>
      )}

      <div className="card version-card">
        <div className="version-card-header">
          <div className="version-section-title"><h3>{t('pd.versions')}</h3><span className="version-count">{versionGroups.length}</span></div>
          <div className="version-actions">
            {canPublishAnnouncements && <button className="primary" onClick={() => setShowUpload(true)}>
              {t('pd.uploadNew')}
            </button>}
          </div>
        </div>
        {renderVersionsTable(versionGroups)}
      </div>

      <AnnouncementBoard
        key={`announcements-${projectId}`}
        projectId={projectId}
        refreshKey={announcementRefresh}
        onPublishPermissionChange={setCanPublishAnnouncements}
      />

      <div className="card version-card version-archive-card">
        <div className="version-card-header">
          <div className="version-section-title"><h3>{t('pd.archives')}</h3><span className="version-count">{archivedGroups.length}</span></div>
        </div>
        {archivedGroups.length > 0 ? (
          <>
            <p className="version-section-hint">{t('pd.archiveHint')}</p>
            {renderVersionsTable(archivedGroups, true)}
          </>
        ) : <p className="version-empty-archive">{t('pd.noArchives')}</p>}
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>{t('pd.apiTokens')}</h3>
          <button
            className="primary"
            onClick={() => {
              setShowTokenDlg(true);
              setNewToken(null);
              setTokName('');
              setTokKind('device');
              setTokScope('download');
              setTokChannel('');
              setTokSpecialVersion('');
              setTokVersion('');
              setTokVersionId(null);
              setTokError(null);
              setTokFileCleared(false);
              setTokenCopied(false);
            }}
          >
            {t('pd.issueToken')}
          </button>
        </div>
        <div className="muted" style={{ marginBottom: 8 }}>
          {t('pd.tokensHint')}
        </div>
        <div className="token-table-scroll">
        <table className="token-table">
          <thead>
            <tr>
              <th>{t('pd.colName')}</th>
              <th>{t('pd.colKind')}</th>
              <th>{t('pd.colScope')}</th>
              <th>{t('pd.tokenAuthorization')}</th>
              <th>{t('pd.colPrefix')}</th>
              <th>{t('pd.colLastUsed')}</th>
              <th>{t('pd.colStatus')}</th>
              <th>{t('pd.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((tk) => (
              <tr key={tk.id} data-token-id={tk.id}>
                <td>{tk.name}</td>
                <td>
                  <span className="tag">{t(`kind.${tk.kind}`)}</span>
                </td>
                <td>
                  <span className="tag">{t(`scope.${tk.scope}`)}</span>
                </td>
                <td><TokenAuthorization token={tk} versions={versions} /></td>
                <td>
                  <span className="code">{tk.tokenPrefix}…</span>
                </td>
                <td className="muted">{tk.lastUsedAt ? new Date(tk.lastUsedAt).toLocaleString() : '—'}</td>
                <td>{tk.revokedAt ? <span className="error">{t('pd.revoked')}</span> : <span className="success">{t('pd.tokenActive')}</span>}</td>
                <td className="token-table-actions">
                  {!tk.revokedAt &&
                    (tk.hasSecret ? (
                      <button onClick={() => copyTokenSecret(tk)} style={{ marginRight: 6 }}>
                        {copiedTokenId === tk.id ? t('pd.copied') : t('pd.copyToken')}
                      </button>
                    ) : (
                      <button disabled style={{ marginRight: 6 }} title={t('pd.copyUnavailable')}>
                        {t('pd.copyToken')}
                      </button>
                    ))}
                  {!tk.revokedAt && (
                    <button onClick={() => revokeToken(tk)} style={{ marginRight: 6 }}>
                      {t('common.revoke')}
                    </button>
                  )}
                  <button className="danger" onClick={() => deleteToken(tk)}>
                    {t('common.delete')}
                  </button>
                </td>
              </tr>
            ))}
            {tokens.length === 0 && (
              <tr>
                <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 16 }}>
                  {t('pd.noTokens')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      {specialVersionDialog !== null && (
        <SpecialVersionDialog
          version={specialVersionDialog}
          value={versions.find((v) => v.version === specialVersionDialog)?.specialVersion ?? ''}
          options={specialVersionList}
          canEdit={versions.find((v) => v.version === specialVersionDialog)?.canEditVersionNotes ?? false}
          current={versions.some((v) => v.version === specialVersionDialog && v.isCurrent)}
          onClose={() => setSpecialVersionDialog(null)}
          onSave={async (specialVersion) => {
            const updated = await api.updateVersionGroup({ projectId, version: specialVersionDialog, specialVersion });
            const byId = new Map(updated.map((v) => [v.id, v]));
            setVersions((items) => items.map((item) => byId.get(item.id) ?? item));
          }}
        />
      )}

      {notesDialog && (
        <VersionNotesDialog
          version={notesDialog.version}
          showVersionNotes={notesDialog.scope === 'version'}
          versionNotes={versions.find((v) => v.version === notesDialog.version)?.versionNotes ?? null}
          canEditVersionNotes={versions.find((v) => v.version === notesDialog.version)?.canEditVersionNotes ?? false}
          items={versions.filter((v) => notesDialog.items.some((item) => item.id === v.id))}
          current={versions.some((v) => v.version === notesDialog.version && v.isCurrent)}
          onClose={() => setNotesDialog(null)}
          onSave={async (versionId, updatedNotes) => {
            const updated = await api.updateVersion(versionId, { notes: updatedNotes });
            patchVersion(versionId, updated);
          }}
          onSaveVersion={async (versionNotes) => {
            const updated = await api.updateVersionGroup({ projectId, version: notesDialog.version, versionNotes });
            const byId = new Map(updated.map((v) => [v.id, v]));
            setVersions((items) => items.map((item) => byId.get(item.id) ?? item));
          }}
        />
      )}

      {showUpload && (
        <UploadFilesDialog
          key={`upload-${projectId}`}
          projectId={projectId}
          defaultChannel={project.defaultChannel || 'stable'}
          channels={channelList}
          versions={versionList}
          existingVersions={versions}
          onClose={() => setShowUpload(false)}
          onRefresh={load}
        />
      )}

      {showTokenDlg && (
        <dialog ref={tokDialogRef} className="dialog token-dialog" aria-labelledby="token-dialog-title" onCancel={(e) => { e.preventDefault(); if (!tokBusyRef.current) setShowTokenDlg(false); }}>
          <form onSubmit={createToken}>
            <h3 id="token-dialog-title">{t('pd.dlgIssueToken')}</h3>
            {newToken ? (
              <>
                <p>
                  {t('pd.tokenIssuedPre')} <strong>{t('pd.notShownAgain')}</strong>:
                </p>
                <div className="code" style={{ padding: 12, userSelect: 'all', wordBreak: 'break-all' }}>
                  {newToken}
                </div>
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(newToken);
                        setTokenCopied(true);
                        setTimeout(() => setTokenCopied(false), 1500);
                      } catch {
                        /* clipboard blocked — the text above is select-all to copy by hand */
                      }
                    }}
                  >
                    {tokenCopied ? t('pd.copied') : t('pd.copyToken')}
                  </button>
                  <button
                    type="button"
                    disabled={tokBusy}
                    onClick={() => {
                      setShowTokenDlg(false);
                      setNewToken(null);
                      setTokenCopied(false);
                    }}
                  >
                    {t('common.done')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <fieldset className="token-form-fields" disabled={tokBusy}>
                <label>
                  <span className="lbl">{t('pd.fldTokenName')}</span>
                  <input aria-label={t('pd.fldTokenName')} value={tokName} onChange={(e) => setTokName(e.target.value)} required autoFocus />
                </label>
                <div className="token-form-grid">
                <label>
                  <span className="lbl">{t('pd.fldKind')}</span>
                  <select
                    value={tokKind}
                    aria-label={t('pd.fldKind')}
                    onChange={(e) => {
                      const k = e.target.value as 'device' | 'ci';
                      setTokKind(k);
                      if (k === 'device') setTokScope('download');
                    }}
                    style={{ width: '100%' }}
                  >
                    <option value="device">{t('pd.kindDevice')}</option>
                    <option value="ci">{t('pd.kindCi')}</option>
                  </select>
                </label>
                {tokKind === 'ci' && (
                  <label>
                    <span className="lbl">{t('pd.fldTokenScope')}</span>
                    <select
                      value={tokScope}
                      aria-label={t('pd.fldTokenScope')}
                      onChange={(e) => setTokScope(e.target.value as 'download' | 'upload' | 'full')}
                      style={{ width: '100%' }}
                    >
                      <option value="upload">{t('pd.scopeUploadOnly')}</option>
                      <option value="download">{t('pd.scopeDownloadOnly')}</option>
                      <option value="full">{t('pd.scopeFullOpt')}</option>
                    </select>
                  </label>
                )}
                </div>
                <section className="token-range-section">
                  <h4>{t('pd.tokenAuthorization')}</h4>
                  <p className="token-range-hint">{t('pd.tokenRangeHint')}</p>
                  <div className="token-form-grid">
                    <label>
                      <span className="lbl">{t('pd.colChannel')}</span>
                      <ChannelField value={tokChannel} onChange={(value) => changeTokenRestriction('channel', value)} options={channelList} allowAny disabled={tokBusy} ariaLabel={t('pd.fldRestrictChannel')} />
                    </label>
                    <label>
                      <span className="lbl">{t('pd.specialVersion')}</span>
                      <select aria-label={t('pd.tokenRestrictSpecial')} value={tokSpecialVersion} onChange={(e) => changeTokenRestriction('specialVersion', e.target.value)}>
                        <option value="">{t('pd.tokenUnrestricted')}</option>
                        {tokenSpecialOptions.map((value) => <option value={value} key={value}>{value}</option>)}
                      </select>
                    </label>
                    <label>
                      <span className="lbl">{t('pd.colVersion')}</span>
                      <select aria-label={t('pd.tokenRestrictVersion')} value={tokVersion} onChange={(e) => changeTokenRestriction('version', e.target.value)}>
                        <option value="">{t('pd.tokenUnrestricted')}</option>
                        {tokenVersionOptions.map((value) => <option value={value} key={value}>{value}</option>)}
                      </select>
                    </label>
                    <label>
                      <span className="lbl">{t('pd.tokenFirmware')}</span>
                      <select aria-label={t('pd.tokenRestrictFile')} value={tokVersionId ?? ''} title={selectedTokenFile ? `${selectedTokenFile.version} / ${selectedTokenFile.releaseChannel} / ${selectedTokenFile.filename}` : undefined} onChange={(e) => { setTokVersionId(e.target.value ? Number(e.target.value) : null); setTokFileCleared(false); setTokError(null); }}>
                        <option value="">{t('pd.tokenUnrestricted')}</option>
                        {tokVersionId !== null && !tokenFileOptions.some((v) => v.id === tokVersionId) && <option value={tokVersionId} disabled>{t('pd.tokenUnavailableFile', { id: tokVersionId })}</option>}
                        {tokenFileOptions.map((file) => <option value={file.id} key={file.id}>{file.version} / {file.releaseChannel} / {file.filename}{file.status === 'archived' ? ` · ${t('status.archived')}` : ''}</option>)}
                      </select>
                    </label>
                  </div>
                  {tokFileCleared && <p className="token-range-warning" role="status">{t('pd.tokenFileCleared')}</p>}
                  {selectedTokenFile && <p className="token-selected-file">{t('pd.tokenSelectedFile')} <strong>{selectedTokenFile.filename}</strong><span>{selectedTokenFile.version} / {selectedTokenFile.releaseChannel} · #{selectedTokenFile.id}</span></p>}
                  <p className={`token-match-summary${!tokenRangeValid ? ' is-empty' : ''}`} role="status">{t(!tokenRangeValid ? 'pd.tokenNoMatches' : tokChannel && !tokenHasVersionRestriction && !tokenMatchingFiles.length ? 'pd.tokenFutureChannel' : 'pd.tokenMatchCount', { count: tokenMatchingFiles.length })}</p>
                </section>
                </fieldset>
                {tokError && <p className="error token-dialog-error" role="alert">{tokError}</p>}
                <div className="dialog-actions">
                  <button type="button" disabled={tokBusy} onClick={() => setShowTokenDlg(false)}>
                    {t('common.cancel')}
                  </button>
                  <button type="submit" className="primary" disabled={tokBusy || !tokName.trim() || !tokenRangeValid}>
                    {t(tokBusy ? 'pd.tokenIssuing' : 'pd.issue')}
                  </button>
                </div>
              </>
            )}
          </form>
        </dialog>
      )}

      {publicVer && (
        <div className="dialog-backdrop" onClick={() => setPublicVer(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>
              {t('pd.dlgPublic')}{' '}
              <span className="muted code" style={{ fontSize: 13 }}>
                {publicVer.version}
              </span>
            </h3>
            <p className="muted" style={{ marginTop: 0 }}>
              {t('pd.publicDesc')}
            </p>
            {publicUrl ? (
              <>
                <label>
                  <span className="lbl">{t('pd.publicLink')}</span>
                  <div className="code" style={{ padding: 12, userSelect: 'all', wordBreak: 'break-all' }}>
                    {publicUrl}
                  </div>
                </label>
                <div
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, margin: '12px 0' }}
                >
                  <div style={{ background: '#fff', padding: 12, borderRadius: 8, lineHeight: 0 }}>
                    <QRCodeSVG value={publicUrl} size={200} level="M" />
                  </div>
                  <div className="muted">{t('pd.publicScan')}</div>
                </div>
                <div className="dialog-actions" style={{ justifyContent: 'space-between' }}>
                  <button className="danger" onClick={disablePublic} disabled={publicBusy}>
                    {t('pd.publicDisable')}
                  </button>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <a className="btn" href={publicUrl} target="_blank" rel="noreferrer">
                      {t('pd.openLink')}
                    </a>
                    <button className="primary" onClick={() => copyPublicLink(publicUrl)}>
                      {linkCopied ? t('pd.copied') : t('pd.copyLink')}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                {publicVer.status !== 'ready' && <p className="error">{t('pd.publicReadyOnly')}</p>}
                <div className="dialog-actions">
                  <button onClick={() => setPublicVer(null)}>{t('common.close')}</button>
                  <button
                    className="primary"
                    onClick={enablePublic}
                    disabled={publicBusy || publicVer.status !== 'ready'}
                  >
                    {t('pd.publicEnable')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function TokenAuthorization({ token, versions }: { token: ApiToken; versions: Version[] }) {
  const { t } = useI18n();
  const file = token.versionId == null ? undefined : versions.find((version) => version.id === token.versionId);
  if (!token.channel && !token.specialVersion && !token.version && token.versionId == null) {
    return <span className="muted">{t('pd.tokenUnrestricted')}</span>;
  }
  const fileLabel = file ? `${file.version} / ${file.releaseChannel} / ${file.filename}` : t('pd.tokenUnavailableFile', { id: token.versionId ?? '' });
  return <div className="token-authorization">
    {token.channel && <span className="token-scope-tag" title={`${t('pd.colChannel')}: ${token.channel}`}><small>{t('pd.colChannel')}</small><span>{token.channel}</span></span>}
    {token.specialVersion && <span className="token-scope-tag" title={`${t('pd.specialVersion')}: ${token.specialVersion}`}><small>{t('pd.specialVersion')}</small><span>{token.specialVersion}</span></span>}
    {token.version && <span className="token-scope-tag" title={`${t('pd.colVersion')}: ${token.version}`}><small>{t('pd.colVersion')}</small><span>{token.version}</span></span>}
    {token.versionId != null && <span className={`token-scope-tag token-file-scope${!file ? ' is-unavailable' : ''}`} title={fileLabel}><small>{t('pd.tokenFirmware')}</small><span>{fileLabel}</span></span>}
  </div>;
}

type UploadQueueStatus = 'waiting' | 'sha256' | 'upload' | 'success' | 'error' | 'cancelled';
type UploadQueueItem = {
  id: number;
  file: File;
  channel: string;
  notes: string;
  notesExpanded: boolean;
  attempted: boolean;
  status: UploadQueueStatus;
  loaded: number;
  error?: string;
};
const uploadChannelPattern = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const uploadFileKey = (filename: string, channel: string) => JSON.stringify([filename, channel]);

function UploadFilesDialog({
  projectId,
  defaultChannel,
  channels,
  versions,
  existingVersions,
  onClose,
  onRefresh,
}: {
  projectId: number;
  defaultChannel: string;
  channels: string[];
  versions: string[];
  existingVersions: Version[];
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nextId = useRef(1);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const cancelRef = useRef(false);
  const jobRef = useRef<UploadJobHandle | null>(null);
  const [queue, setQueue] = useState<UploadQueueItem[]>([]);
  const [version, setVersion] = useState('');
  const [versionNotes, setVersionNotes] = useState('');
  const [specialVersion, setSpecialVersion] = useState('');
  const [publishAnnouncement, setPublishAnnouncement] = useState(false);
  const [announcementContent, setAnnouncementContent] = useState('');
  const [mailSelection, setMailSelection] = useState(emptyMailSelection);
  const [mailReady, setMailReady] = useState(true);
  const announcementBatchKey = useRef<string | null>(null);
  const [mandatory, setMandatory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [started, setStarted] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ items: UploadQueueItem[]; existingItems: UploadQueueItem[] } | null>(null);

  const channelOptions = useMemo(() => [...new Set([
    ...channels,
    defaultChannel,
    ...queue.map((item) => item.channel).filter((value) => uploadChannelPattern.test(value)),
  ])].sort(), [channels, defaultChannel, queue]);
  const specialVersionOptions = useMemo(() => [...new Set(existingVersions.map((item) => item.specialVersion).filter((value): value is string => !!value))].sort(), [existingVersions]);
  const duplicateIds = useMemo(() => {
    const keys = new Map<string, number>();
    const duplicates = new Set<number>();
    for (const item of queue) {
      const key = uploadFileKey(item.file.name, item.channel);
      const existingId = keys.get(key);
      if (existingId !== undefined) {
        duplicates.add(existingId);
        duplicates.add(item.id);
      } else keys.set(key, item.id);
    }
    return duplicates;
  }, [queue]);

  useEffect(() => {
    alive.current = true;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      alive.current = false;
      cancelRef.current = true;
      void jobRef.current?.abort().catch(() => {});
      dialog?.close();
    };
  }, []);

  function updateItem(id: number, patch: Partial<UploadQueueItem>) {
    if (alive.current) setQueue((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function addFiles(files: File[]) {
    if (busyRef.current) return;
    const keys = new Set(queue.map((item) => uploadFileKey(item.file.name, item.channel)));
    const duplicates = new Set<string>();
    const added: UploadQueueItem[] = [];
    for (const file of files) {
      const key = uploadFileKey(file.name, defaultChannel);
      if (keys.has(key)) {
        duplicates.add(file.name);
        continue;
      }
      keys.add(key);
      added.push({ id: nextId.current++, file, channel: defaultChannel, notes: '', notesExpanded: false, attempted: false, status: 'waiting', loaded: 0 });
    }
    setQueue((items) => [...items, ...added]);
    setSelectionError(duplicates.size ? t('pd.duplicateSelection', { names: [...duplicates].join('、'), channel: defaultChannel }) : null);
    setConflict(null);
    setError(null);
  }

  function changeFileChannel(item: UploadQueueItem, channel: string) {
    if (busyRef.current || item.attempted) return;
    updateItem(item.id, { channel });
    setConflict(null);
    setSelectionError(null);
    setError(null);
  }

  async function runQueue(items: UploadQueueItem[], overwriteIds: Set<number>) {
    if (publishAnnouncement && !announcementBatchKey.current) announcementBatchKey.current = crypto.randomUUID();
    setStarted(true);
    setConflict(null);
    const previousVersionNotes = existingVersions.find((item) => item.version === version)?.versionNotes ?? '';
    const uploadVersionNotes = versionNotes === previousVersionNotes ? undefined : versionNotes.trim() ? versionNotes : null;
    const previousSpecialVersion = existingVersions.find((item) => item.version === version)?.specialVersion ?? '';
    const uploadSpecialVersion = specialVersion.trim() === previousSpecialVersion ? undefined : specialVersion.trim() || null;
    const ids = new Set(items.map((item) => item.id));
    setQueue((all) => all.map((item) => ids.has(item.id) ? { ...item, status: 'waiting', loaded: 0, error: undefined } : item));
    try {
      for (const item of items) {
        if (cancelRef.current || !alive.current) break;
        updateItem(item.id, { status: 'sha256', loaded: 0, error: undefined, attempted: true });
        try {
          const job = startUpload({
            projectId,
            file: item.file,
            version,
            releaseChannel: item.channel,
            notes: item.notes || undefined,
            versionNotes: uploadVersionNotes,
            specialVersion: uploadSpecialVersion,
            announcement: publishAnnouncement ? { batchKey: announcementBatchKey.current!, content: announcementContent.trim(), recipientIds: mailSelection.enabled ? mailSelection.recipientIds : undefined } : undefined,
            isMandatory: mandatory,
            overwriteExisting: overwriteIds.has(item.id),
            concurrency: 4,
            onProgress: (loaded, _total, phase) => {
              if (!cancelRef.current) updateItem(item.id, { loaded: Math.min(loaded, item.file.size), status: phase });
            },
          });
          jobRef.current = job;
          await job.promise;
          updateItem(item.id, { status: 'success', loaded: item.file.size });
        } catch (e: any) {
          updateItem(item.id, {
            status: cancelRef.current || e?.name === 'AbortError' ? 'cancelled' : 'error',
            error: cancelRef.current || e?.name === 'AbortError' ? undefined : e?.message ?? String(e),
          });
        } finally {
          jobRef.current = null;
        }
      }
    } finally {
      if (alive.current) {
        if (cancelRef.current) {
          setQueue((all) => all.map((item) => ids.has(item.id) && ['waiting', 'sha256', 'upload'].includes(item.status)
            ? { ...item, status: 'cancelled' }
            : item));
        }
        try {
          await onRefresh();
        } catch (e: any) {
          if (alive.current) setError(e?.message ?? String(e));
        } finally {
          if (alive.current) {
            setBusy(false);
            setCancelling(false);
          }
        }
      }
      busyRef.current = false;
    }
  }

  async function prepareUpload(e: FormEvent) {
    e.preventDefault();
    if (busyRef.current || !version) return;
    if (publishAnnouncement && !announcementContent.trim()) {
      setError(t('pd.uploadAnnouncementRequired'));
      return;
    }
    if (publishAnnouncement && mailSelection.enabled && (!mailReady || !mailSelection.recipientIds.length)) {
      setError(t('mail.chooseRecipients'));
      return;
    }
    if (duplicateIds.size) {
      setError(t('pd.duplicateFileChannels'));
      return;
    }
    const items = queue.filter((item) => ['waiting', 'error', 'cancelled'].includes(item.status));
    if (!items.length) return;
    if (items.some((item) => !uploadChannelPattern.test(item.channel))) {
      setError(t('pd.invalidFileChannel'));
      return;
    }
    busyRef.current = true;
    cancelRef.current = false;
    setBusy(true);
    setCancelling(false);
    setError(null);
    setConflict(null);
    try {
      const existing = await api.listVersions(projectId, { includePending: true });
      if (!alive.current || cancelRef.current) {
        if (alive.current) {
          const ids = new Set(items.map((item) => item.id));
          setQueue((all) => all.map((item) => ids.has(item.id) ? { ...item, status: 'cancelled' } : item));
        }
        return;
      }
      const existingItems = items.filter((item) => existing.some((v) => v.version === version
        && v.releaseChannel === item.channel && v.filename === item.file.name));
      if (existingItems.length) {
        setConflict({ items, existingItems });
        return;
      }
      await runQueue(items, new Set());
    } catch (e: any) {
      if (alive.current) setError(e?.message ?? String(e));
    } finally {
      busyRef.current = false;
      if (alive.current) {
        setBusy(false);
        setCancelling(false);
      }
    }
  }

  async function confirmOverwrite() {
    if (!conflict || busyRef.current || duplicateIds.size) return;
    if (publishAnnouncement && !announcementContent.trim()) {
      setError(t('pd.uploadAnnouncementRequired'));
      return;
    }
    if (publishAnnouncement && mailSelection.enabled && (!mailReady || !mailSelection.recipientIds.length)) {
      setError(t('mail.chooseRecipients'));
      return;
    }
    busyRef.current = true;
    cancelRef.current = false;
    setBusy(true);
    setCancelling(false);
    setError(null);
    await runQueue(conflict.items, new Set(conflict.existingItems.map((item) => item.id)));
  }

  async function cancelUpload() {
    cancelRef.current = true;
    setCancelling(true);
    try {
      await jobRef.current?.abort();
    } catch (e: any) {
      if (alive.current) setError(e?.message ?? String(e));
    }
  }

  function newBatch() {
    setQueue([]);
    setStarted(false);
    setSelectionError(null);
    setError(null);
    setConflict(null);
    setPublishAnnouncement(false);
    setAnnouncementContent('');
    setMailSelection(emptyMailSelection());
    setMailReady(true);
    announcementBatchKey.current = null;
  }

  const readyCount = queue.filter((item) => ['waiting', 'error', 'cancelled'].includes(item.status)).length;
  const successCount = queue.filter((item) => item.status === 'success').length;
  const failedCount = queue.filter((item) => item.status === 'error').length;
  const cancelledCount = queue.filter((item) => item.status === 'cancelled').length;
  const totalSize = queue.reduce((sum, item) => sum + item.file.size, 0);
  const existingVersion = existingVersions.find((item) => item.version === version);
  const versionNotesLocked = !!existingVersion && !existingVersion.canEditVersionNotes;

  return (
    <dialog
      ref={dialogRef}
      className="dialog upload-dialog"
      aria-labelledby="upload-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busyRef.current) onClose();
      }}
    >
      <form onSubmit={prepareUpload}>
        <div className="upload-dialog-heading">
          <div><h3 id="upload-dialog-title">{t('pd.dlgUpload')}</h3><p>{t('pd.batchUploadHint')}</p></div>
          <button type="button" disabled={busy} onClick={onClose}>{t('common.close')}</button>
        </div>
        <div className="upload-dialog-body">
          <div className="upload-file-picker">
            <div><strong>{t('pd.uploadFiles')}</strong><span>{t('pd.selectedFiles', { count: queue.length, size: formatBytes(totalSize) })}</span></div>
            <label className={`upload-select-button${busy ? ' is-disabled' : ''}`}>
              {t(queue.length ? 'pd.addFiles' : 'pd.chooseFiles')}
              <input
                type="file"
                multiple
                className="upload-file-input"
                aria-label={t('pd.chooseFiles')}
                disabled={busy}
                onChange={(e) => {
                  addFiles(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          {selectionError && <p className="upload-selection-warning" role="alert">{selectionError}</p>}
          {queue.length ? (
            <ul className="upload-file-list">
              {queue.map((item, index) => {
                const active = item.status === 'sha256' || item.status === 'upload';
                const percentage = item.file.size > 0 ? Math.round(item.loaded / item.file.size * 100) : 0;
                return (
                  <li className={`upload-file-row upload-file-${item.status}${duplicateIds.has(item.id) ? ' upload-file-duplicate' : ''}`} key={item.id} data-upload-id={item.id}>
                    <div className="upload-file-main">
                      <span className="upload-file-icon"><VersionIcon name="notes" /></span>
                      <div className="upload-file-detail">
                        <span className="upload-file-name" title={item.file.name}>{item.file.name}</span>
                        <span className="upload-file-size">{formatBytes(item.file.size)}{active ? ` · ${percentage}%` : ''}</span>
                      </div>
                      <div className="upload-file-channel">
                        <label htmlFor={`upload-channel-${item.id}`}>{t('pd.fldChannel')}</label>
                        <ChannelField
                          id={`upload-channel-${item.id}`}
                          ariaLabel={t('pd.fileChannelLabel', { index: index + 1, filename: item.file.name })}
                          value={item.channel}
                          onChange={(value) => changeFileChannel(item, value)}
                          options={channelOptions}
                          required
                          disabled={busy || item.attempted}
                        />
                      </div>
                      <span className={`upload-file-status ${item.status}`}>{t(`pd.uploadStatus.${item.status}`)}</span>
                      <button
                        type="button"
                        className="upload-remove-file"
                        disabled={busy}
                        title={t('pd.removeFile', { filename: `${item.channel} / ${item.file.name}` })}
                        aria-label={t('pd.removeFile', { filename: `${item.channel} / ${item.file.name}` })}
                        onClick={() => { setQueue((items) => items.filter((entry) => entry.id !== item.id)); setConflict(null); }}
                      >×</button>
                    </div>
                    <div className="upload-file-notes">
                      <button
                        type="button"
                        className="upload-file-notes-toggle"
                        aria-expanded={item.notesExpanded}
                        aria-controls={`upload-notes-${item.id}`}
                        aria-label={t('pd.fileNotesLabel', { index: index + 1, filename: item.file.name })}
                        onClick={() => updateItem(item.id, { notesExpanded: !item.notesExpanded })}
                      >
                        <VersionIcon name="notes" />
                        {t(item.notes.trim() ? 'pd.fileNotesFilled' : 'pd.fileNotes')}
                        <span aria-hidden="true">{item.notesExpanded ? '−' : '+'}</span>
                      </button>
                      {item.notesExpanded && (
                        <textarea
                          id={`upload-notes-${item.id}`}
                          aria-label={t('pd.fileNotesLabel', { index: index + 1, filename: item.file.name })}
                          value={item.notes}
                          onChange={(e) => {
                            if (busyRef.current || item.attempted) return;
                            updateItem(item.id, { notes: e.target.value });
                            setConflict(null);
                          }}
                          placeholder={t('pd.fileNotesPlaceholder')}
                          rows={2}
                          disabled={busy || item.attempted}
                        />
                      )}
                    </div>
                    {active && <div className="progress" role="progressbar" aria-label={item.file.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}><div style={{ width: `${percentage}%` }} /></div>}
                    {item.error && <p className="upload-file-error" role="alert">{item.error}</p>}
                    {duplicateIds.has(item.id) && <p className="upload-file-error" role="alert">{t('pd.duplicateFileChannel', { channel: item.channel })}</p>}
                  </li>
                );
              })}
            </ul>
          ) : <div className="upload-file-empty">{t('pd.fileSelectionHint')}</div>}
          <div className="upload-version-fields">
            <label>
              <span className="lbl">{t('pd.fldVersion')}</span>
              <VersionField value={version} onChange={(value) => {
                setVersion(value);
                setVersionNotes(existingVersions.find((item) => item.version === value)?.versionNotes ?? '');
                setSpecialVersion(existingVersions.find((item) => item.version === value)?.specialVersion ?? '');
                setConflict(null);
              }} options={versions} disabled={busy || started} />
            </label>
            <label>
              <span className="lbl">{t('pd.specialVersion')}</span>
              <SpecialVersionField
                key={version}
                value={specialVersion}
                onChange={setSpecialVersion}
                options={specialVersionOptions}
                disabled={busy || started || versionNotesLocked}
              />
              <span className="upload-notes-hint">{t(versionNotesLocked
                ? existingVersions.some((item) => item.version === version && item.isCurrent) ? 'pd.specialVersionCurrentLocked' : 'pd.specialVersionPermissionHint'
                : 'pd.specialVersionHint')}</span>
            </label>
          </div>
          <label>
            <span className="lbl">{t('pd.versionNotes')}</span>
            <textarea
              className="upload-version-notes"
              aria-label={t('pd.versionNotes')}
              value={versionNotes}
              onChange={(e) => setVersionNotes(e.target.value)}
              rows={3}
              disabled={busy || started}
              readOnly={versionNotesLocked}
            />
            <span className="upload-notes-hint">{t(versionNotesLocked
              ? existingVersions.some((item) => item.version === version && item.isCurrent) ? 'pd.notesCurrentLocked' : 'pd.versionNotesPermissionHint'
              : 'pd.uploadVersionNotesHint')}</span>
          </label>
          <label className="upload-mandatory"><input type="checkbox" checked={mandatory} onChange={(e) => setMandatory(e.target.checked)} disabled={busy || started} /> {t('pd.fldMandatory')}</label>
          <section className={`upload-announcement${publishAnnouncement ? ' is-enabled' : ''}`}>
            <label className="upload-announcement-toggle">
              <input
                type="checkbox"
                checked={publishAnnouncement}
                onChange={(e) => { setPublishAnnouncement(e.target.checked); setMailSelection(emptyMailSelection()); setMailReady(true); setError(null); setConflict(null); }}
                disabled={busy || started}
              />
              <span>{t('pd.uploadAnnouncement')}</span>
            </label>
            {publishAnnouncement && (
              <>
                <p className="upload-notes-hint">{t('pd.uploadAnnouncementHint')}</p>
                <label>
                  <span className="lbl">{t('pd.uploadAnnouncementContent')}</span>
                  <textarea
                    className="upload-announcement-content"
                    aria-label={t('pd.uploadAnnouncementContent')}
                    value={announcementContent}
                    onChange={(e) => { setAnnouncementContent(e.target.value); setConflict(null); }}
                    rows={4}
                    maxLength={10000}
                    required
                    disabled={busy || started}
                  />
                  <span className="upload-announcement-count">{announcementContent.length.toLocaleString()} / 10,000</span>
                </label>
                <MailRecipients projectId={projectId} value={mailSelection} onChange={setMailSelection} onReadyChange={setMailReady} disabled={busy || started} />
                {successCount > 0 && <p className="success upload-announcement-success" role="status">{t('pd.uploadAnnouncementPublished')}</p>}
              </>
            )}
          </section>
          {started && <p className="upload-batch-lock-hint">{t('pd.batchSettingsLocked')}</p>}
          {error && <p className="error" role="alert">{error}</p>}
          {conflict && (
            <div className="inline-warning" role="alert">
              <strong>{t('pd.uploadConflictTitle')}</strong>
              <p>{t('pd.batchConflictBody', { version, count: conflict.existingItems.length })}</p>
              <ul className="upload-conflict-files">{conflict.existingItems.map((item) => <li key={item.id}><span className="tag">{item.channel}</span> {item.file.name}</li>)}</ul>
              <div className="dialog-actions">
                <button type="button" onClick={() => setConflict(null)}>{t('pd.reviewSelection')}</button>
                <button type="button" className="primary" onClick={confirmOverwrite}>{t('pd.overwriteAndUpload')}</button>
              </div>
            </div>
          )}
        </div>
        <div className="upload-dialog-footer">
          <div className="upload-summary" aria-live="polite">
            {started ? t('pd.uploadSummary', { success: successCount, failed: failedCount, cancelled: cancelledCount }) : t('pd.uploadSequentialHint')}
          </div>
          <div className="version-actions">
            {busy ? (
              <button type="button" className="danger" onClick={cancelUpload} disabled={cancelling}>{t(cancelling ? 'pd.cancellingUploads' : 'pd.cancelUpload')}</button>
            ) : (
              <>
                {started && <button type="button" onClick={newBatch}>{t('pd.newUploadBatch')}</button>}
                {readyCount > 0 && <button type="submit" className="primary" disabled={!version || !!conflict || duplicateIds.size > 0 || (publishAnnouncement && mailSelection.enabled && (!mailReady || !mailSelection.recipientIds.length))}>{t(started ? 'pd.retryRemaining' : 'pd.startUpload')}</button>}
                {started && readyCount === 0 && <button type="button" className="primary" onClick={onClose}>{t('common.done')}</button>}
              </>
            )}
          </div>
        </div>
      </form>
    </dialog>
  );
}

function VersionIcon({ name }: { name: 'download' | 'public' | 'delete' | 'notes' | 'chevron' | 'edit' }) {
  const paths = {
    download: <><path d="M12 3v12m-4-4 4 4 4-4" /><path d="M5 15v5h14v-5" /></>,
    public: <><path d="m10 13 4-4" /><path d="m8 16-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0)" /></>,
    delete: <><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6m4-6v6" /></>,
    notes: <><path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7m-7 4h5" /></>,
    edit: <><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z" /></>,
    chevron: <path d="m9 5 7 7-7 7" />,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function groupNotes(items: Version[]) {
  const groups = new Map<string, { notes: string; items: Version[] }>();
  for (const item of items) {
    const notes = item.notes?.trim() ? item.notes : '';
    const existing = groups.get(notes);
    if (existing) existing.items.push(item);
    else groups.set(notes, { notes, items: [item] });
  }
  return [...groups.values()];
}

function VersionNotesDialog({
  version,
  items,
  current,
  showVersionNotes,
  versionNotes,
  canEditVersionNotes,
  onClose,
  onSave,
  onSaveVersion,
}: {
  version: string;
  items: Version[];
  current: boolean;
  showVersionNotes: boolean;
  versionNotes: string | null;
  canEditVersionNotes: boolean;
  onClose: () => void;
  onSave: (id: number, notes: string | null) => Promise<void>;
  onSaveVersion: (notes: string | null) => Promise<void>;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingVersion, setEditingVersion] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const editing = items.find((item) => item.id === editingId);
  const editable = !current && (editingVersion ? canEditVersionNotes : editing?.canEditNotes);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if ((!editingVersion && !editing) || !editable || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const value = draft.trim() ? draft : null;
      if (editingVersion) await onSaveVersion(value);
      else await onSave(editing!.id, value);
      setEditingId(null);
      setEditingVersion(false);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const editorLabel = editingVersion ? t('pd.versionNotes') : editing
    ? t('pd.editFileNotes', { channel: editing.releaseChannel, filename: editing.filename })
    : t('pd.fileNotes');
  const renderEditor = () => (
    <form onSubmit={save}>
      <label>
        <span className="lbl">{editorLabel}</span>
        <textarea
          className="version-notes-editor"
          aria-label={editorLabel}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={saving || !editable}
          autoFocus
        />
      </label>
      {!editingVersion && <p className="notes-layer-description">{t('pd.notesEditHint')}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" disabled={saving} onClick={() => { setEditingId(null); setEditingVersion(false); setError(null); }}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="primary" disabled={saving || !editable}>
          {saving ? t('pd.savingNotes') : t('common.save')}
        </button>
      </div>
    </form>
  );

  return (
    <dialog
      ref={dialogRef}
      className="dialog version-notes-dialog"
      aria-labelledby="version-notes-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!saving) onClose();
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget || saving) return;
        const bounds = e.currentTarget.getBoundingClientRect();
        if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) {
          onClose();
        }
      }}
    >
      <div className="version-notes-header">
        <h3 id="version-notes-title">{t(showVersionNotes ? 'pd.notesDetails' : 'pd.fileNotes')} <span className="code">{version}</span></h3>
        <button type="button" onClick={onClose} disabled={saving} autoFocus>{t('common.close')}</button>
      </div>
      {current && <p className="version-notes-hint">{t('pd.notesCurrentLocked')}</p>}
      <div className="version-notes-body">
        {showVersionNotes && (
          <section className="notes-layer version-level-notes">
            <div className="notes-layer-heading">
              <h4>{t('pd.versionNotes')}</h4>
              {canEditVersionNotes && !current && !editingVersion && (
                <button
                  type="button"
                  disabled={saving || editingId !== null}
                  onClick={() => { setEditingVersion(true); setDraft(versionNotes ?? ''); setError(null); }}
                >
                  {t('pd.editVersionNotes')}
                </button>
              )}
            </div>
            <p className="notes-layer-description">{t('pd.versionNotesEditHint')}</p>
            {!current && !canEditVersionNotes && <p className="version-notes-hint">{t('pd.versionNotesPermissionHint')}</p>}
            {editingVersion ? renderEditor() : (
              <div className="version-notes-text">{versionNotes || ''}</div>
            )}
          </section>
        )}
        <section className="notes-layer file-level-notes">
          {showVersionNotes && <div className="notes-layer-heading"><h4>{t('pd.fileNotes')}</h4></div>}
          {!current && items.some((item) => !item.canEditNotes) && <p className="version-notes-hint">{t('pd.notesPermissionHint')}</p>}
          {editing ? renderEditor() : groupNotes(items).map((entry) => (
            <section className="version-notes-section" key={entry.items[0]!.id}>
              <div className="version-note-files">
                {entry.items.map((item) => (
                  <div className="version-note-file-row" key={item.id}>
                    <div className="version-note-file-identity">
                      <span className="tag">{item.releaseChannel}</span>
                      <span className="version-note-filename" title={item.filename}>{item.filename}</span>
                    </div>
                    {item.canEditNotes && !current && (
                      <button
                        type="button"
                        disabled={saving || editingVersion}
                        title={t('pd.editFileNotes', { channel: item.releaseChannel, filename: item.filename })}
                        aria-label={t('pd.editFileNotes', { channel: item.releaseChannel, filename: item.filename })}
                        onClick={() => {
                          setEditingId(item.id);
                          setDraft(item.notes ?? '');
                          setError(null);
                        }}
                      >
                        {t('pd.editNotes')}
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="version-notes-text">
                {entry.notes || ''}
              </div>
            </section>
          ))}
        </section>
      </div>
    </dialog>
  );
}

function SpecialVersionDialog({ version, value, options, canEdit, current, onClose, onSave }: {
  version: string;
  value: string;
  options: string[];
  canEdit: boolean;
  current: boolean;
  onClose: () => void;
  onSave: (value: string | null) => Promise<void>;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = canEdit && !current;

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editable || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSave(draft.trim() || null);
      onClose();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog version-notes-dialog special-version-dialog"
      aria-labelledby="special-version-title"
      onCancel={(e) => { e.preventDefault(); if (!savingRef.current) onClose(); }}
    >
      <div className="version-notes-header">
        <h3 id="special-version-title">{t('pd.specialVersion')} <span className="code">{version}</span></h3>
        <button type="button" onClick={onClose} disabled={saving} autoFocus>{t('common.close')}</button>
      </div>
      <form onSubmit={save}>
        <label>
          <span className="lbl">{t('pd.specialVersion')}</span>
          <SpecialVersionField value={draft} onChange={setDraft} options={options} disabled={saving || !editable} />
        </label>
        <p className="notes-layer-description">{t(current ? 'pd.specialVersionCurrentLocked' : !canEdit ? 'pd.specialVersionPermissionHint' : 'pd.specialVersionHint')}</p>
        {error && <p className="error" role="alert">{error}</p>}
        {editable && (
          <div className="dialog-actions">
            <button type="button" onClick={onClose} disabled={saving}>{t('common.cancel')}</button>
            <button type="submit" className="primary" disabled={saving}>{saving ? t('pd.savingNotes') : t('common.save')}</button>
          </div>
        )}
      </form>
    </dialog>
  );
}

function SpecialVersionField({ value, onChange, options, disabled = false }: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <SelectOrCreateField
      value={value}
      onChange={onChange}
      options={options}
      disabled={disabled}
      ariaLabel={t('pd.specialVersion')}
      maxLength={128}
      allowAny
      anyLabel={t('pd.specialVersionNone')}
      newLabel={t('pd.specialVersionNew')}
      backLabel={t('pd.specialVersionBack')}
    />
  );
}

function ChannelField({
  value,
  onChange,
  options,
  allowAny = false,
  disabled = false,
  required = false,
  id,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  allowAny?: boolean;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  ariaLabel?: string;
}) {
  const { t } = useI18n();
  return (
    <SelectOrCreateField
      value={value}
      onChange={onChange}
      options={options}
      allowAny={allowAny}
      disabled={disabled}
      required={required}
      id={id}
      ariaLabel={ariaLabel}
      pattern="^[a-z0-9][a-z0-9_\-]{0,31}$"
      anyLabel={t('pd.tokenChannelAny')}
      newLabel={t('pd.channelNew')}
      backLabel={t('pd.channelBack')}
      fallbackValue={options[0] ?? 'stable'}
    />
  );
}

function VersionField({
  value,
  onChange,
  options,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <SelectOrCreateField
      value={value}
      onChange={onChange}
      options={options}
      disabled={disabled}
      pattern="^[A-Za-z0-9._+\-]{1,64}$"
      required
      emptyLabel={t('pd.versionPick')}
      newLabel={t('pd.versionNew')}
      backLabel={t('pd.versionBack')}
    />
  );
}

function SelectOrCreateField({
  value,
  onChange,
  options,
  allowAny = false,
  disabled = false,
  pattern,
  maxLength,
  required = false,
  anyLabel,
  emptyLabel,
  newLabel,
  backLabel,
  fallbackValue,
  id,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  allowAny?: boolean;
  disabled?: boolean;
  pattern?: string;
  maxLength?: number;
  required?: boolean;
  anyLabel?: string;
  emptyLabel?: string;
  newLabel: string;
  backLabel: string;
  fallbackValue?: string;
  id?: string;
  ariaLabel?: string;
}) {
  let NEW = '__new__';
  while (options.includes(NEW)) NEW += '_';
  // Start in "create" mode if the current value is not in the existing choices.
  const [creating, setCreating] = useState(() => value !== '' && !options.includes(value));

  if (creating) {
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        <input
          id={id}
          aria-label={ariaLabel}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          pattern={pattern}
          maxLength={maxLength}
          required={required}
          disabled={disabled}
          autoFocus
          style={{ width: '100%' }}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setCreating(false);
            onChange(allowAny ? '' : fallbackValue ?? options[0] ?? '');
          }}
          style={{ justifySelf: 'start' }}
        >
          {backLabel}
        </button>
      </div>
    );
  }

  const selectValue = value === '' || options.includes(value) ? value : NEW;

  return (
    <select
      id={id}
      aria-label={ariaLabel}
      value={selectValue}
      disabled={disabled}
      required={required}
      onChange={(e) => {
        if (e.target.value === NEW) {
          setCreating(true);
          onChange('');
        } else {
          onChange(e.target.value);
        }
      }}
      style={{ width: '100%' }}
    >
      {allowAny && <option value="">{anyLabel}</option>}
      {!allowAny && emptyLabel && (
        <option value="" disabled>
          {emptyLabel}
        </option>
      )}
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
      <option value={NEW}>{newLabel}</option>
    </select>
  );
}

function groupVersions(versions: Version[]) {
  const groups = new Map<string, Version[]>();
  for (const v of versions) {
    const list = groups.get(v.version);
    if (list) list.push(v);
    else groups.set(v.version, [v]);
  }

  return [...groups.entries()].flatMap(([label, items]) => {
    const [first, ...rest] = items;
    if (!first) return [];
    const latest = rest.reduce((best, item) => (item.createdAt > best.createdAt ? item : best), first);
    const channels = [...new Set(items.map((item) => item.releaseChannel))];
    const statusCounts = new Map<Version['status'], number>();
    for (const item of items) statusCounts.set(item.status, (statusCounts.get(item.status) ?? 0) + 1);
    const sortedItems = [...items].sort(
      (a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.createdAt - a.createdAt,
    );
    return {
      label,
      items: sortedItems,
      latest,
      channels,
      statusCounts,
      totalSize: items.reduce((sum, item) => sum + item.size, 0),
      totalDownloads: items.reduce((sum, item) => sum + item.downloadCount, 0),
      hasCurrent: items.some((item) => item.isCurrent),
      hasReady: items.some((item) => item.status === 'ready'),
      hasPublic: items.some((item) => item.publicSlug),
    };
  }).sort((a, b) => Number(b.hasCurrent) - Number(a.hasCurrent) || b.latest.createdAt - a.latest.createdAt);
}
