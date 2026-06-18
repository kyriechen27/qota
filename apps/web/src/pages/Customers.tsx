import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { slugify } from '../lib/slug';
import type { Customer } from '@qota/shared';

export default function Customers() {
  const { user } = useAuth();
  const { t } = useI18n();
  const isAdmin = user?.role === 'super_admin' || user?.role === 'admin';
  const [items, setItems] = useState<Customer[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [codeEdited, setCodeEdited] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');

  function onNameChange(value: string) {
    setName(value);
    // Live-generate the code from the name until the user edits the code field.
    if (!codeEdited) setCode(slugify(value));
  }

  function onCodeChange(value: string) {
    setCode(value);
    setCodeEdited(true);
  }

  async function load() {
    try {
      setItems(await api.listCustomers());
    } catch (e: any) {
      setErr(e?.message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.createCustomer({ code: code.trim() || undefined, name: name.trim(), description: desc.trim() || undefined });
      setOpen(false);
      setCode('');
      setCodeEdited(false);
      setName('');
      setDesc('');
      await load();
    } catch (e: any) {
      setErr(e?.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    if (!confirm(t('customers.confirmDelete'))) return;
    try {
      await api.deleteCustomer(id);
      await load();
    } catch (e: any) {
      setErr(e?.message);
    }
  }

  return (
    <>
      <h2 className="page-title">{t('customers.title')}</h2>
      <div className="page-actions">
        {isAdmin && (
          <button
            className="primary"
            onClick={() => {
              setCode('');
              setCodeEdited(false);
              setName('');
              setDesc('');
              setOpen(true);
            }}
          >
            {t('customers.new')}
          </button>
        )}
      </div>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      <table>
        <thead>
          <tr>
            <th>{t('customers.colName')}</th>
            <th>{t('customers.colCode')}</th>
            <th>{t('customers.colDesc')}</th>
            <th>{t('customers.colCreated')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td>
                <Link to={`/projects?customerId=${c.id}`}>{c.name}</Link>
              </td>
              <td><span className="code">{c.code}</span></td>
              <td className="muted">{c.description || '—'}</td>
              <td className="muted">{new Date(c.createdAt).toLocaleDateString()}</td>
              <td>
                {isAdmin && (
                  <button className="danger" onClick={() => remove(c.id)}>
                    {t('common.delete')}
                  </button>
                )}
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                {t('customers.empty')}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {open && (
        <div className="dialog-backdrop" onClick={() => !busy && setOpen(false)}>
          <form className="dialog" onSubmit={create} onClick={(e) => e.stopPropagation()}>
            <h3>{t('customers.dlgNew')}</h3>
            <label>
              <span className="lbl">{t('customers.fldName')}</span>
              <input value={name} onChange={(e) => onNameChange(e.target.value)} required style={{ width: '100%' }} autoFocus />
            </label>
            <label>
              <span className="lbl">{t('customers.fldCode')}</span>
              <input
                value={code}
                onChange={(e) => onCodeChange(e.target.value)}
                pattern="^[a-z0-9][a-z0-9_\-]{0,63}$"
                style={{ width: '100%' }}
              />
            </label>
            <label>
              <span className="lbl">{t('customers.fldDesc')}</span>
              <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} style={{ width: '100%' }} />
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
