import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { customerHierarchy } from '../lib/customer-tree';
import { groupVersions } from '../lib/version-groups';
import { formatBytes } from '../lib/utils';
import { useI18n } from '../lib/i18n';
import type { AccessibleVersion, Customer } from '@qota/shared';
import './files.css';

export default function Files() {
  const { t } = useI18n();
  const [items, setItems] = useState<AccessibleVersion[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [searchExpanded, setSearchExpanded] = useState<Map<string, boolean>>(new Map());
  const [downloading, setDownloading] = useState<Set<number>>(new Set());
  const downloadRequests = useRef(new Set<number>());
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setErr(null);
    Promise.all([api.listAccessibleVersions(), api.listCustomers()])
      .then(([files, visibleCustomers]) => { if (active) { setItems(files); setCustomers(visibleCustomers); } })
      .catch((error) => { if (active) setErr(error.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reload]);

  async function download(version: AccessibleVersion) {
    if (downloadRequests.current.has(version.id)) return;
    downloadRequests.current.add(version.id);
    setDownloading(new Set(downloadRequests.current));
    setErr(null);
    try {
      const grant = await api.grantDownload(version.id);
      if (!mounted.current) return;
      const anchor = document.createElement('a');
      anchor.href = grant.url;
      anchor.download = grant.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (error: any) { if (mounted.current) setErr(error.message); }
    finally {
      downloadRequests.current.delete(version.id);
      if (mounted.current) setDownloading(new Set(downloadRequests.current));
    }
  }

  const tree = useMemo(() => customerHierarchy(customers), [customers]);
  const query = q.trim().toLowerCase();
  const customerPath = (version: AccessibleVersion) => tree.paths.get(version.customerId) ?? version.customerName;
  const filtered = useMemo(() => {
    if (!query) return items;
    return items.filter((version) => [
      tree.paths.get(version.customerId) ?? version.customerName,
      version.customerName, version.customerCode, version.projectName, version.projectCode,
      version.version, version.filename, version.releaseChannel,
    ].some((value) => value.toLowerCase().includes(query)));
  }, [items, tree, query]);
  const groups = useMemo(() => groupVersions(filtered), [filtered]);
  function isExpanded(key: string) { return query ? searchExpanded.get(key) ?? true : expanded.has(key); }
  function toggle(key: string) {
    if (query) setSearchExpanded((current) => { const next = new Map(current); next.set(key, !(current.get(key) ?? true)); return next; });
    else setExpanded((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }
  function updateSearch(value: string) { setQ(value); setSearchExpanded(new Map()); }
  function channelTag(channel: string) {
    return <span className={`tag ${channel === 'stable' ? 'stable' : channel === 'beta' ? 'beta' : ''}`} title={channel}>{channel}</span>;
  }
  function uploadedTime(timestamp: number) {
    const date = new Date(timestamp);
    return <time className="version-upload-time" dateTime={date.toISOString()}>
      <span>{date.toLocaleDateString()}</span><span>{date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
    </time>;
  }
  function projectLink(version: AccessibleVersion, subdued = false) {
    return <div className={`files-project${subdued ? ' is-subdued' : ''}`}>
      <Link to={`/projects/${version.projectId}`} onClick={(event) => event.stopPropagation()} title={version.projectName}>{version.projectName}</Link>
      <span className="muted" title={version.projectCode}>{version.projectCode}</span>
    </div>;
  }

  return <>
    <h2 className="page-title">{t('files.title')}</h2>
    {err && <div className="error files-error" role="alert"><span>{err}</span><button type="button" disabled={loading} onClick={() => setReload((value) => value + 1)}>{t('common.retry')}</button></div>}
    <div className="card files-card">
      <div className="toolbar files-toolbar">
        <input type="search" aria-label={t('files.search')} placeholder={t('files.search')} value={q} onChange={(event) => updateSearch(event.target.value)} />
        <span className="muted files-count" aria-live="polite">{t('files.count', { count: filtered.length })}</span>
      </div>
      {query && <p className="muted files-search-hint">{t('files.searchExpandedHint')}</p>}
      <div className="files-table-scroll" tabIndex={0} role="region" aria-label={t('files.title')}>
        <table className="files-table">
          <colgroup><col style={{ width: 200 }} /><col style={{ width: 170 }} /><col style={{ width: 178 }} /><col style={{ width: 120 }} /><col style={{ width: 90 }} /><col style={{ width: 220 }} /><col style={{ width: 116 }} /><col style={{ width: 112 }} /><col style={{ width: 90 }} /></colgroup>
          <thead><tr><th>{t('files.colCustomer')}</th><th>{t('files.colProject')}</th><th>{t('pd.colVersion')}</th><th>{t('pd.colChannel')}</th><th>{t('pd.colSize')}</th><th>{t('pd.colFilename')}</th><th>{t('pd.colUploaded')}</th><th>{t('pd.colSha')}</th><th>{t('pd.colActions')}</th></tr></thead>
          <tbody>
            {groups.map((group) => {
              const first = group.latest;
              const open = isExpanded(group.key);
              const toggleLabel = t(open ? 'files.collapseVersion' : 'files.expandVersion', { project: first.projectName, version: group.label });
              return <Fragment key={group.key}>
                <tr className="files-group-row" data-project-id={group.projectId} data-version-label={group.label} onClick={() => toggle(group.key)}>
                  <td><span className="files-customer-path" title={customerPath(first)}>{customerPath(first)}</span></td>
                  <td>{projectLink(first)}</td>
                  <td><div className="version-group-main">
                    <button type="button" className={`version-toggle${open ? ' is-expanded' : ''}`} aria-expanded={open} aria-label={toggleLabel} title={toggleLabel} onClick={(event) => { event.stopPropagation(); toggle(group.key); }}>
                      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </button>
                    <div className="version-identity"><span className="version-label" title={group.label}>{group.label}</span><span className="version-meta">{group.hasCurrent ? <span className="tag current">{t('pd.currentTag')}</span> : <span>{t('pd.channelCount', { count: group.channels.length })}</span>}</span></div>
                  </div></td>
                  <td><span className="version-channel-list">{group.channels.slice(0, 2).map((channel) => <Fragment key={channel}>{channelTag(channel)}</Fragment>)}{group.channels.length > 2 && <span className="version-channel-more" title={group.channels.slice(2).join(', ')}>+{group.channels.length - 2}</span>}</span></td>
                  <td className="files-size">{formatBytes(group.totalSize)}</td>
                  <td className="files-firmware-count">{t('pd.firmwareCount', { count: group.items.length })}</td>
                  <td>{uploadedTime(group.latest.createdAt)}</td>
                  <td><span className="muted">—</span></td>
                  <td><button type="button" className="files-action" aria-expanded={open} aria-label={toggleLabel} onClick={(event) => { event.stopPropagation(); toggle(group.key); }}>{t(open ? 'pd.collapse' : 'pd.expand')}</button></td>
                </tr>
                {open && group.items.map((version) => <tr key={version.id} className="files-detail-row" data-version-id={version.id}>
                  <td><span className="files-customer-path muted" title={customerPath(version)}>{customerPath(version)}</span></td>
                  <td>{projectLink(version, true)}</td>
                  <td><div className="version-identity files-detail-version"><span className="version-label" title={version.version}>{version.version}</span>{version.isCurrent && <span className="version-meta"><span className="tag current">{t('pd.currentTag')}</span></span>}</div></td>
                  <td>{channelTag(version.releaseChannel)}</td>
                  <td className="files-size">{formatBytes(version.size)}</td>
                  <td><span className="version-filename" title={version.filename}>{version.filename}</span></td>
                  <td>{uploadedTime(version.createdAt)}</td>
                  <td><span className="version-checksum" title={version.sha256 ?? ''}>{version.sha256 ? `${version.sha256.slice(0, 12)}…` : '—'}</span></td>
                  <td><button type="button" className="files-action" disabled={downloading.has(version.id)} aria-label={t('files.downloadFile', { filename: version.filename })} onClick={(event) => { event.stopPropagation(); void download(version); }}>{t(downloading.has(version.id) ? 'common.loading' : 'pd.download')}</button></td>
                </tr>)}
              </Fragment>;
            })}
            {(loading || !groups.length) && <tr><td colSpan={9} className="muted files-empty">{t(loading ? 'common.loading' : 'files.empty')}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  </>;
}
