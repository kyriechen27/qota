import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { Customer, Project } from '@qota/shared';

export default function Dashboard() {
  const { t } = useI18n();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [c, p] = await Promise.all([api.listCustomers(), api.listProjects()]);
        setCustomers(c);
        setProjects(p);
      } catch (e: any) {
        setErr(e?.message ?? t('dashboard.loadFailed'));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <h2 className="page-title">{t('dashboard.title')}</h2>
      {err && <div className="error">{err}</div>}
      <div className="card">
        <h3>{t('dashboard.overview')}</h3>
        <div className="muted">
          {t('dashboard.access', { customers: customers.length, projects: projects.length })}
        </div>
      </div>
      <div className="card">
        <h3>{t('dashboard.recent')}</h3>
        {projects.length === 0 && <div className="muted">{t('dashboard.noProjects')}</div>}
        <ul style={{ paddingLeft: 0, listStyle: 'none' }}>
          {projects.slice(0, 10).map((p) => (
            <li key={p.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <Link to={`/projects/${p.id}`}>
                <span className="code">{p.code}</span> — {p.name}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
