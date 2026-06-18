import { Fragment, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../lib/api';
import { startUpload, type UploadJobHandle } from '../lib/upload';
import { formatBytes } from '../lib/utils';
import { useI18n } from '../lib/i18n';
import type { ApiToken, Project, Version } from '@qota/shared';

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const projectId = Number(id);
  const { t } = useI18n();
  const [project, setProject] = useState<Project | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [expandedVersionGroups, setExpandedVersionGroups] = useState<Set<string>>(() => new Set());
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [err, setErr] = useState<string | null>(null);

  // upload state
  const [showUpload, setShowUpload] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState('');
  const [channel, setChannel] = useState('stable');
  const [notes, setNotes] = useState('');
  const [mandatory, setMandatory] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'sha256' | 'upload'>('idle');
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const [job, setJob] = useState<UploadJobHandle | null>(null);
  const [uploadConflict, setUploadConflict] = useState<Version | null>(null);

  // token state
  const [showTokenDlg, setShowTokenDlg] = useState(false);
  const [tokName, setTokName] = useState('');
  const [tokKind, setTokKind] = useState<'device' | 'ci'>('device');
  const [tokScope, setTokScope] = useState<'download' | 'upload' | 'full'>('download');
  const [tokChannel, setTokChannel] = useState('');
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

  const versionGroups = useMemo(() => {
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
        hasMandatory: items.some((item) => item.isMandatory),
        hasCurrent: items.some((item) => item.isCurrent),
        hasReady: items.some((item) => item.status === 'ready'),
        hasPublic: items.some((item) => item.publicSlug),
      };
    }).sort((a, b) => Number(b.hasCurrent) - Number(a.hasCurrent) || b.latest.createdAt - a.latest.createdAt);
  }, [versions]);

  async function load() {
    try {
      const p = await api.getProject(projectId);
      setProject(p);
      const [v, tk] = await Promise.all([
        api.listVersions(projectId),
        api.listApiTokens(projectId).catch(() => [] as ApiToken[]),
      ]);
      setVersions(v);
      setTokens(tk);
    } catch (e: any) {
      setErr(e?.message);
    }
  }

  useEffect(() => {
    if (Number.isFinite(projectId)) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function runUpload(overwriteExisting = false) {
    if (!file || !version) return;
    setUploadConflict(null);
    setErr(null);
    setPhase('sha256');
    setProgress({ loaded: 0, total: file.size });
    const handle = startUpload({
      projectId,
      file,
      version,
      releaseChannel: channel || 'stable',
      notes: notes || undefined,
      isMandatory: mandatory,
      overwriteExisting,
      concurrency: 4,
      onProgress: (loaded, total, ph) => {
        setPhase(ph);
        setProgress({ loaded, total });
      },
    });
    setJob(handle);
    try {
      await handle.promise;
      setShowUpload(false);
      setFile(null);
      setVersion('');
      setNotes('');
      setMandatory(false);
      setPhase('idle');
      setProgress({ loaded: 0, total: 0 });
      setJob(null);
      await load();
    } catch (e: any) {
      if (e?.name !== 'AbortError') setErr(e?.message ?? String(e));
      setPhase('idle');
      setJob(null);
    }
  }

  async function startUploadHandler(e: FormEvent) {
    e.preventDefault();
    if (!file || !version) return;
    const releaseChannel = channel || 'stable';
    const existing = versions.find((v) => v.version === version && v.releaseChannel === releaseChannel);
    if (existing) {
      setErr(null);
      setUploadConflict(existing);
      return;
    }
    await runUpload(false);
  }

  async function cancelUpload() {
    if (!job) return;
    await job.abort();
    setPhase('idle');
    setProgress({ loaded: 0, total: 0 });
    setJob(null);
  }

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

  async function deleteVer(v: Version) {
    if (!confirm(t('pd.confirmDeleteVer', { version: v.version, channel: v.releaseChannel }))) return;
    try {
      await api.deleteVersion(v.id);
      await load();
    } catch (e: any) {
      setErr(e?.message);
    }
  }

  async function archiveVer(v: Version) {
    try {
      await api.updateVersion(v.id, { status: 'archived' });
      await load();
    } catch (e: any) {
      setErr(e?.message);
    }
  }

  async function restoreVer(v: Version) {
    try {
      await api.updateVersion(v.id, { status: 'ready' });
      await load();
    } catch (e: any) {
      setErr(e?.message);
    }
  }

  async function setCurrentVersion(versionLabel: string) {
    try {
      await api.updateProject(projectId, { currentVersion: versionLabel });
      await load();
    } catch (e: any) {
      setErr(e?.message);
    }
  }

  async function createToken(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      const tk = await api.createApiToken({
        projectId,
        name: tokName,
        kind: tokKind,
        scope: tokKind === 'device' ? 'download' : tokScope,
        channel: tokChannel || undefined,
      });
      setNewToken(tk.token);
      setTokName('');
      setTokChannel('');
      await load();
    } catch (e: any) {
      setErr(e?.message);
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
    let token: string;
    try {
      ({ token } = await api.revealApiToken(tk.id));
    } catch (e: any) {
      setErr(e?.message);
      return;
    }
    try {
      await navigator.clipboard.writeText(token);
      setCopiedTokenId(tk.id);
      setTimeout(() => setCopiedTokenId((id) => (id === tk.id ? null : id)), 1500);
    } catch {
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

  const pct = progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;
  const publicUrl = publicVer?.publicSlug ? publicUrlFor(publicVer.publicSlug) : null;
  const renderChannelTag = (releaseChannel: string) => (
    <span className={`tag ${releaseChannel === 'stable' ? 'stable' : releaseChannel === 'beta' ? 'beta' : ''}`}>
      {releaseChannel}
    </span>
  );
  const statusSummary = (statusCounts: Map<Version['status'], number>) =>
    [...statusCounts.entries()]
      .map(([status, count]) => `${t(`status.${status}`)}${count > 1 ? ` x${count}` : ''}`)
      .join(' / ');
  const renderVersionActions = (v: Version, showCurrentAction = true) => (
    <>
      <button onClick={() => download(v)} style={{ marginRight: 6 }} disabled={v.status !== 'ready'}>
        {t('pd.download')}
      </button>
      <button
        onClick={() => openPublic(v)}
        style={{ marginRight: 6 }}
        disabled={v.status !== 'ready' && !v.publicSlug}
        className={v.publicSlug ? 'primary' : ''}
        title={t('pd.dlgPublic')}
      >
        {v.publicSlug ? `${t('pd.public')} ✓` : t('pd.public')}
      </button>
      {v.status === 'ready' && (
        <button onClick={() => archiveVer(v)} style={{ marginRight: 6 }}>
          {t('pd.archive')}
        </button>
      )}
      {showCurrentAction && v.status === 'ready' && (
        <button onClick={() => setCurrentVersion(v.version)} style={{ marginRight: 6 }} disabled={v.isCurrent}>
          {v.isCurrent ? t('pd.currentVersion') : t('pd.setCurrent')}
        </button>
      )}
      {v.status === 'archived' && (
        <button onClick={() => restoreVer(v)} style={{ marginRight: 6 }}>
          {t('pd.restore')}
        </button>
      )}
      <button className="danger" onClick={() => deleteVer(v)}>
        {t('common.delete')}
      </button>
    </>
  );
  const renderVersionRow = (v: Version, grouped = false) => (
    <tr key={v.id} className={grouped ? 'version-detail-row' : undefined}>
      <td>
        <span className="code">{v.version}</span>
        {!grouped && v.isCurrent && (
          <span className="tag current" style={{ marginLeft: 6 }}>
            {t('pd.currentTag')}
          </span>
        )}
        {v.publicSlug && (
          <span className="tag" style={{ marginLeft: 6 }}>
            {t('pd.publicTag')}
          </span>
        )}
      </td>
      <td>{renderChannelTag(v.releaseChannel)}</td>
      <td>
        <span className={`tag ${v.status === 'ready' ? 'stable' : ''}`}>{t(`status.${v.status}`)}</span>
      </td>
      <td>{formatBytes(v.size)}</td>
      <td>
        <span className="code" title={v.sha256 ?? ''}>
          {v.sha256 ? `${v.sha256.slice(0, 12)}...` : '-'}
        </span>
      </td>
      <td>{v.isMandatory ? '✓' : ''}</td>
      <td className="muted">{new Date(v.createdAt).toLocaleString()}</td>
      <td>{v.downloadCount}</td>
      <td>{renderVersionActions(v, !grouped)}</td>
    </tr>
  );

  return (
    <>
      <h2 className="page-title">
        {project.name}{' '}
        <span className="muted code" style={{ fontSize: 13 }}>
          {project.code}
        </span>
      </h2>
      {err && (
        <div className="error" style={{ marginBottom: 12 }}>
          {err}
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>{t('pd.versions')}</h3>
          <button className="primary" onClick={() => setShowUpload(true)}>
            {t('pd.uploadNew')}
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>{t('pd.colVersion')}</th>
              <th>{t('pd.colChannel')}</th>
              <th>{t('pd.colStatus')}</th>
              <th>{t('pd.colSize')}</th>
              <th>{t('pd.colSha')}</th>
              <th>{t('pd.colMandatory')}</th>
              <th>{t('pd.colUploaded')}</th>
              <th>{t('pd.colDownloads')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {versionGroups.map((group) => {
              const [first] = group.items;
              if (!first) return null;
              if (group.items.length === 1) return renderVersionRow(first);

              const expanded = expandedVersionGroups.has(group.label);
              const onlyStatus = group.statusCounts.size === 1 ? group.latest.status : null;
              return (
                <Fragment key={`group-${group.label}`}>
                  <tr className="version-group-row" onClick={() => toggleVersionGroup(group.label)}>
                    <td>
                      <span className="version-group-main">
                        <button
                          type="button"
                          className="version-toggle"
                          aria-expanded={expanded}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleVersionGroup(group.label);
                          }}
                        >
                          {expanded ? '-' : '+'}
                        </button>
                        <span className="code">{group.label}</span>
                        <span className="tag">{t('pd.channelCount', { count: group.items.length })}</span>
                        {group.hasCurrent && <span className="tag current">{t('pd.currentTag')}</span>}
                        {group.hasPublic && <span className="tag">{t('pd.publicTag')}</span>}
                      </span>
                    </td>
                    <td>
                      <span className="tag-list">{group.channels.map((ch) => <Fragment key={ch}>{renderChannelTag(ch)}</Fragment>)}</span>
                    </td>
                    <td>
                      <span className={`tag ${onlyStatus === 'ready' ? 'stable' : ''}`}>
                        {statusSummary(group.statusCounts)}
                      </span>
                    </td>
                    <td>{formatBytes(group.totalSize)}</td>
                    <td>
                      <span className="muted">-</span>
                    </td>
                    <td>{group.hasMandatory ? '✓' : ''}</td>
                    <td className="muted">{new Date(group.latest.createdAt).toLocaleString()}</td>
                    <td>{group.totalDownloads}</td>
                    <td>
                      {group.hasReady && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void setCurrentVersion(group.label);
                          }}
                          disabled={group.hasCurrent}
                          style={{ marginRight: 6 }}
                        >
                          {group.hasCurrent ? t('pd.currentVersion') : t('pd.setCurrent')}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleVersionGroup(group.label);
                        }}
                      >
                        {expanded ? t('pd.collapse') : t('pd.expand')}
                      </button>
                    </td>
                  </tr>
                  {expanded && group.items.map((v) => renderVersionRow(v, true))}
                </Fragment>
              );
            })}
            {versions.length === 0 && (
              <tr>
                <td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  {t('pd.noVersions')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>{t('pd.apiTokens')}</h3>
          <button
            className="primary"
            onClick={() => {
              setShowTokenDlg(true);
              setNewToken(null);
            }}
          >
            {t('pd.issueToken')}
          </button>
        </div>
        <div className="muted" style={{ marginBottom: 8 }}>
          {t('pd.tokensHint')}
        </div>
        <table>
          <thead>
            <tr>
              <th>{t('pd.colName')}</th>
              <th>{t('pd.colKind')}</th>
              <th>{t('pd.colScope')}</th>
              <th>{t('pd.colChannel')}</th>
              <th>{t('pd.colPrefix')}</th>
              <th>{t('pd.colLastUsed')}</th>
              <th>{t('pd.colStatus')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((tk) => (
              <tr key={tk.id}>
                <td>{tk.name}</td>
                <td>
                  <span className="tag">{t(`kind.${tk.kind}`)}</span>
                </td>
                <td>
                  <span className="tag">{t(`scope.${tk.scope}`)}</span>
                </td>
                <td>{tk.channel ?? <span className="muted">{t('pd.tokenChannelAny')}</span>}</td>
                <td>
                  <span className="code">{tk.tokenPrefix}…</span>
                </td>
                <td className="muted">{tk.lastUsedAt ? new Date(tk.lastUsedAt).toLocaleString() : '—'}</td>
                <td>{tk.revokedAt ? <span className="error">{t('pd.revoked')}</span> : <span className="success">{t('pd.tokenActive')}</span>}</td>
                <td>
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

      {showUpload && (
        <div className="dialog-backdrop" onClick={() => phase === 'idle' && setShowUpload(false)}>
          <form className="dialog" onSubmit={startUploadHandler} onClick={(e) => e.stopPropagation()}>
            <h3>{t('pd.dlgUpload')}</h3>
            <label>
              <span className="lbl">{t('pd.fldFile')}</span>
              <input
                type="file"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setUploadConflict(null);
                }}
                required
                disabled={phase !== 'idle'}
              />
              {file && (
                <div className="muted" style={{ marginTop: 4 }}>
                  {file.name} — {formatBytes(file.size)}
                </div>
              )}
            </label>
            <label>
              <span className="lbl">{t('pd.fldVersion')}</span>
              <VersionField
                value={version}
                onChange={(v) => {
                  setVersion(v);
                  setUploadConflict(null);
                }}
                options={versionList}
                disabled={phase !== 'idle'}
              />
            </label>
            <label>
              <span className="lbl">{t('pd.fldChannel')}</span>
              <ChannelField
                value={channel}
                onChange={(v) => {
                  setChannel(v);
                  setUploadConflict(null);
                }}
                options={channelList}
                disabled={phase !== 'idle'}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={mandatory}
                onChange={(e) => setMandatory(e.target.checked)}
                disabled={phase !== 'idle'}
              />{' '}
              {t('pd.fldMandatory')}
            </label>
            <label>
              <span className="lbl">{t('pd.fldNotes')}</span>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} disabled={phase !== 'idle'} style={{ width: '100%' }} />
            </label>
            {uploadConflict && phase === 'idle' && (
              <div className="inline-warning">
                <strong>{t('pd.uploadConflictTitle')}</strong>
                <div className="muted">
                  {t('pd.uploadConflictBody', {
                    version,
                    channel: channel || 'stable',
                    existing: uploadConflict.filename,
                    current: file?.name ?? '',
                  })}
                </div>
                <div className="dialog-actions" style={{ marginTop: 10 }}>
                  <button type="button" onClick={() => setUploadConflict(null)}>
                    {t('pd.renameUpload')}
                  </button>
                  <button type="button" className="primary" onClick={() => void runUpload(true)}>
                    {t('pd.overwriteUpload')}
                  </button>
                </div>
              </div>
            )}
            {phase !== 'idle' && (
              <div style={{ margin: '12px 0' }}>
                <div className="muted" style={{ marginBottom: 4 }}>
                  {phase === 'sha256' ? t('pd.hashing') : t('pd.uploadingR2')} {pct}%
                </div>
                <div className="progress">
                  <div style={{ width: `${pct}%` }} />
                </div>
                <div className="muted" style={{ marginTop: 4 }}>
                  {formatBytes(progress.loaded)} / {formatBytes(progress.total)}
                </div>
              </div>
            )}
            <div className="dialog-actions">
              {phase !== 'idle' ? (
                <button type="button" className="danger" onClick={cancelUpload}>
                  {t('pd.cancelUpload')}
                </button>
              ) : (
                <>
                  <button type="button" onClick={() => setShowUpload(false)}>
                    {t('common.close')}
                  </button>
                  <button type="submit" className="primary" disabled={!file || !version}>
                    {t('pd.startUpload')}
                  </button>
                </>
              )}
            </div>
          </form>
        </div>
      )}

      {showTokenDlg && (
        <div className="dialog-backdrop" onClick={() => setShowTokenDlg(false)}>
          <form className="dialog" onSubmit={createToken} onClick={(e) => e.stopPropagation()}>
            <h3>{t('pd.dlgIssueToken')}</h3>
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
                <label>
                  <span className="lbl">{t('pd.fldTokenName')}</span>
                  <input value={tokName} onChange={(e) => setTokName(e.target.value)} required style={{ width: '100%' }} />
                </label>
                <label>
                  <span className="lbl">{t('pd.fldKind')}</span>
                  <select
                    value={tokKind}
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
                      onChange={(e) => setTokScope(e.target.value as 'download' | 'upload' | 'full')}
                      style={{ width: '100%' }}
                    >
                      <option value="upload">{t('pd.scopeUploadOnly')}</option>
                      <option value="download">{t('pd.scopeDownloadOnly')}</option>
                      <option value="full">{t('pd.scopeFullOpt')}</option>
                    </select>
                  </label>
                )}
                <label>
                  <span className="lbl">{t('pd.fldRestrictChannel')}</span>
                  <ChannelField value={tokChannel} onChange={setTokChannel} options={channelList} allowAny />
                </label>
                <div className="dialog-actions">
                  <button type="button" onClick={() => setShowTokenDlg(false)}>
                    {t('common.cancel')}
                  </button>
                  <button type="submit" className="primary">
                    {t('pd.issue')}
                  </button>
                </div>
              </>
            )}
          </form>
        </div>
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

function ChannelField({
  value,
  onChange,
  options,
  allowAny = false,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  allowAny?: boolean;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <SelectOrCreateField
      value={value}
      onChange={onChange}
      options={options}
      allowAny={allowAny}
      disabled={disabled}
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
  required = false,
  anyLabel,
  emptyLabel,
  newLabel,
  backLabel,
  fallbackValue,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  allowAny?: boolean;
  disabled?: boolean;
  pattern?: string;
  required?: boolean;
  anyLabel?: string;
  emptyLabel?: string;
  newLabel: string;
  backLabel: string;
  fallbackValue?: string;
}) {
  const NEW = '__new__';
  // Start in "create" mode if the current value is not in the existing choices.
  const [creating, setCreating] = useState(() => value !== '' && !options.includes(value));

  if (creating) {
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          pattern={pattern}
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
