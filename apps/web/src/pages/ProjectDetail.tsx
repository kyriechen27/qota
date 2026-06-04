import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
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

  // token state
  const [showTokenDlg, setShowTokenDlg] = useState(false);
  const [tokName, setTokName] = useState('');
  const [tokKind, setTokKind] = useState<'device' | 'ci'>('device');
  const [tokScope, setTokScope] = useState<'download' | 'upload' | 'full'>('download');
  const [tokChannel, setTokChannel] = useState('');
  const [newToken, setNewToken] = useState<string | null>(null);

  // Channels available for this project: the project default + every channel
  // already used by a version. New ones are created inline in the dialogs.
  const channelList = useMemo(() => {
    const set = new Set<string>();
    set.add(project?.defaultChannel || 'stable');
    for (const v of versions) set.add(v.releaseChannel);
    return [...set].sort();
  }, [project, versions]);

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

  async function startUploadHandler(e: FormEvent) {
    e.preventDefault();
    if (!file || !version) return;
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
            {versions.map((v) => (
              <tr key={v.id}>
                <td>
                  <span className="code">{v.version}</span>
                </td>
                <td>
                  <span
                    className={`tag ${v.releaseChannel === 'stable' ? 'stable' : v.releaseChannel === 'beta' ? 'beta' : ''}`}
                  >
                    {v.releaseChannel}
                  </span>
                </td>
                <td>
                  <span className={`tag ${v.status === 'ready' ? 'stable' : ''}`}>{t(`status.${v.status}`)}</span>
                </td>
                <td>{formatBytes(v.size)}</td>
                <td>
                  <span className="code" title={v.sha256 ?? ''}>
                    {v.sha256 ? `${v.sha256.slice(0, 12)}…` : '—'}
                  </span>
                </td>
                <td>{v.isMandatory ? '✓' : ''}</td>
                <td className="muted">{new Date(v.createdAt).toLocaleString()}</td>
                <td>{v.downloadCount}</td>
                <td>
                  <button onClick={() => download(v)} style={{ marginRight: 6 }} disabled={v.status !== 'ready'}>
                    {t('pd.download')}
                  </button>
                  {v.status === 'ready' && (
                    <button onClick={() => archiveVer(v)} style={{ marginRight: 6 }}>
                      {t('pd.archive')}
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
                </td>
              </tr>
            ))}
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
                  {!tk.revokedAt && (
                    <button className="danger" onClick={() => revokeToken(tk)}>
                      {t('common.revoke')}
                    </button>
                  )}
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
              <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required disabled={phase !== 'idle'} />
              {file && (
                <div className="muted" style={{ marginTop: 4 }}>
                  {file.name} — {formatBytes(file.size)}
                </div>
              )}
            </label>
            <label>
              <span className="lbl">{t('pd.fldVersion')}</span>
              <input
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                pattern="^[A-Za-z0-9._+\-]{1,64}$"
                required
                disabled={phase !== 'idle'}
                style={{ width: '100%' }}
              />
            </label>
            <label>
              <span className="lbl">{t('pd.fldChannel')}</span>
              <ChannelField value={channel} onChange={setChannel} options={channelList} disabled={phase !== 'idle'} />
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
                    onClick={() => {
                      setShowTokenDlg(false);
                      setNewToken(null);
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
  const NEW = '__new__';
  // Start in "create" mode if the current value is a channel not in the list.
  const [creating, setCreating] = useState(() => value !== '' && !options.includes(value));

  if (creating) {
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          pattern="^[a-z0-9][a-z0-9_\-]{0,31}$"
          disabled={disabled}
          autoFocus
          style={{ width: '100%' }}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setCreating(false);
            onChange(allowAny ? '' : options[0] ?? 'stable');
          }}
          style={{ justifySelf: 'start' }}
        >
          {t('pd.channelBack')}
        </button>
      </div>
    );
  }

  return (
    <select
      value={allowAny && value === '' ? '' : value}
      disabled={disabled}
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
      {allowAny && <option value="">{t('pd.tokenChannelAny')}</option>}
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
      <option value={NEW}>{t('pd.channelNew')}</option>
    </select>
  );
}
