import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatBytes } from '../lib/utils';
import { useI18n } from '../lib/i18n';
import type { AccessibleVersion } from '@qota/shared';

// "All files" — a cross-project catalog of every version the logged-in user can
// download, so an account holder can find/grab everything they're entitled to in
// one place (the account+password counterpart to the device-token /device/list).
export default function Files() {
  const { t } = useI18n();
  const [items, setItems] = useState<AccessibleVersion[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        setItems(await api.listAccessibleVersions());
      } catch (e: any) {
        setErr(e?.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function download(v: AccessibleVersion) {
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

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter((v) =>
      [v.customerName, v.customerCode, v.projectName, v.projectCode, v.version, v.filename]
        .some((f) => f.toLowerCase().includes(s)),
    );
  }, [items, q]);

  return (
    <>
      <h2 className="page-title">{t('files.title')}</h2>
      {err && (
        <div className="error" style={{ marginBottom: 12 }}>
          {err}
        </div>
      )}
      <div className="card">
        <div className="toolbar" style={{ marginBottom: 12 }}>
          <input placeholder={t('files.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="muted">{t('files.count', { count: filtered.length })}</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>{t('files.colCustomer')}</th>
              <th>{t('files.colProject')}</th>
              <th>{t('pd.colVersion')}</th>
              <th>{t('pd.colChannel')}</th>
              <th>{t('pd.colSize')}</th>
              <th>{t('pd.colSha')}</th>
              <th>{t('pd.colUploaded')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((v) => (
              <tr key={v.id}>
                <td>
                  <span className="code">{v.customerCode}</span> {v.customerName}
                </td>
                <td>
                  <Link to={`/projects/${v.projectId}`}>
                    <span className="code">{v.projectCode}</span>
                  </Link>{' '}
                  {v.projectName}
                </td>
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
                <td>{formatBytes(v.size)}</td>
                <td>
                  <span className="code" title={v.sha256 ?? ''}>
                    {v.sha256 ? `${v.sha256.slice(0, 12)}…` : '—'}
                  </span>
                </td>
                <td className="muted">{new Date(v.createdAt).toLocaleString()}</td>
                <td>
                  <button onClick={() => download(v)}>{t('pd.download')}</button>
                </td>
              </tr>
            ))}
            {loading && (
              <tr>
                <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  {t('common.loading')}
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  {t('files.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
