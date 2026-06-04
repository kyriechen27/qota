import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { slugify } from '../lib/slug';
import type { Customer, Project } from '@qota/shared';

export default function Projects() {
  const { user } = useAuth();
  const { t } = useI18n();
  const isAdmin = user?.role === 'super_admin';
  const [params, setParams] = useSearchParams();
  const customerIdParam = params.get('customerId');
  const customerId = customerIdParam ? Number(customerIdParam) : undefined;

  const [projects, setProjects] = useState<Project[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ customerId: customerId ?? 0, code: '', name: '', description: '' });
  const [codeEdited, setCodeEdited] = useState(false);

  function onNameChange(value: string) {
    // Live-generate the code from the name until the user edits the code field.
    setForm((f) => ({ ...f, name: value, code: codeEdited ? f.code : slugify(value) }));
  }

  function onCodeChange(value: string) {
    setCodeEdited(true);
    setForm((f) => ({ ...f, code: value }));
  }

  async function load() {
    try {
      const [p, c] = await Promise.all([api.listProjects(customerId), api.listCustomers()]);
      setProjects(p);
      setCustomers(c);
    } catch (e: any) {
      setErr(e?.message);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  const customerName = useMemo(() => {
    const m = new Map(customers.map((c) => [c.id, c.code]));
    return (id: number) => m.get(id) ?? `#${id}`;
  }, [customers]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.createProject({
        customerId: Number(form.customerId),
        code: form.code.trim() || undefined,
        name: form.name.trim(),
        description: form.description.trim() || undefined,
      });
      setOpen(false);
      setForm({ customerId: customerId ?? 0, code: '', name: '', description: '' });
      setCodeEdited(false);
      await load();
    } catch (e: any) {
      setErr(e?.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    if (!confirm(t('projects.confirmDelete'))) return;
    try {
      await api.deleteProject(id);
      await load();
    } catch (e: any) {
      setErr(e?.message);
    }
  }

  return (
    <>
      <h2 className="page-title">{t('projects.title')}</h2>
      <div className="page-actions toolbar">
        <select
          value={customerIdParam ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            if (v) setParams({ customerId: v });
            else setParams({});
          }}
        >
          <option value="">{t('projects.allCustomers')}</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} — {c.name}
            </option>
          ))}
        </select>
        {isAdmin && (
          <button
            className="primary"
            onClick={() => {
              setForm({ customerId: customerId ?? 0, code: '', name: '', description: '' });
              setCodeEdited(false);
              setOpen(true);
            }}
            disabled={customers.length === 0}
          >
            {t('projects.new')}
          </button>
        )}
      </div>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      <table>
        <thead>
          <tr>
            <th>{t('projects.colCustomer')}</th>
            <th>{t('projects.colName')}</th>
            <th>{t('projects.colCode')}</th>
            <th>{t('projects.colDesc')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id}>
              <td><span className="code">{customerName(p.customerId)}</span></td>
              <td>
                <Link to={`/projects/${p.id}`}>{p.name}</Link>
              </td>
              <td><span className="code">{p.code}</span></td>
              <td className="muted">{p.description || '—'}</td>
              <td>
                {isAdmin && (
                  <button className="danger" onClick={() => remove(p.id)}>
                    {t('common.delete')}
                  </button>
                )}
              </td>
            </tr>
          ))}
          {projects.length === 0 && (
            <tr>
              <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                {t('projects.empty')}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {open && (
        <div className="dialog-backdrop" onClick={() => !busy && setOpen(false)}>
          <form className="dialog" onSubmit={create} onClick={(e) => e.stopPropagation()}>
            <h3>{t('projects.dlgNew')}</h3>
            <label>
              <span className="lbl">{t('projects.fldCustomer')}</span>
              <select
                value={form.customerId}
                onChange={(e) => setForm({ ...form, customerId: Number(e.target.value) })}
                required
                style={{ width: '100%' }}
              >
                <option value={0} disabled>
                  {t('common.select')}
                </option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} — {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="lbl">{t('projects.fldName')}</span>
              <input
                value={form.name}
                onChange={(e) => onNameChange(e.target.value)}
                required
                style={{ width: '100%' }}
              />
            </label>
            <label>
              <span className="lbl">{t('projects.fldCode')}</span>
              <input
                value={form.code}
                onChange={(e) => onCodeChange(e.target.value)}
                pattern="^[a-z0-9][a-z0-9_\-]{0,63}$"
                style={{ width: '100%' }}
              />
            </label>
            <label>
              <span className="lbl">{t('projects.fldDesc')}</span>
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={3}
                style={{ width: '100%' }}
              />
            </label>
            <div className="dialog-actions">
              <button type="button" onClick={() => setOpen(false)} disabled={busy}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="primary" disabled={busy}>
                {t('common.create')}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
