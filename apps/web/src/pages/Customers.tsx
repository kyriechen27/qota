import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { slugify } from '../lib/slug';
import { customerHierarchy } from '../lib/customer-tree';
import type { Customer } from '@qota/shared';
import './customer-memberships.css';

export default function Customers() {
  const { user } = useAuth();
  const { t } = useI18n();
  const isAdmin = user?.role === 'super_admin' || user?.role === 'admin';
  const [items, setItems] = useState<Customer[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [editor, setEditor] = useState<{ item?: Customer; parentId: number | null } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState<number | null>(null);
  const deleteRef = useRef(false);
  const tree = useMemo(() => customerHierarchy(items), [items]);
  const visibleEntries = useMemo(() => {
    const hidden = new Set<number>();
    return tree.entries.filter((entry) => {
      if (entry.parentId !== null && (collapsed.has(entry.parentId) || hidden.has(entry.parentId))) {
        hidden.add(entry.customer.id);
        return false;
      }
      return true;
    });
  }, [tree, collapsed]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setErr(null);
    api.listCustomers().then((data) => { if (active) setItems(data); })
      .catch((error) => { if (active) setErr(error.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reload]);

  async function remove(customer: Customer) {
    if (deleteRef.current || !confirm(t('customers.confirmDelete'))) return;
    deleteRef.current = true;
    setDeleting(customer.id);
    setErr(null);
    try {
      await api.deleteCustomer(customer.id);
      setItems((current) => current.filter((item) => item.id !== customer.id));
    } catch (error: any) { setErr(error.message); }
    finally { deleteRef.current = false; setDeleting(null); }
  }

  return <>
    <h2 className="page-title">{t('customers.title')}</h2>
    <p className="muted hierarchy-intro">{t('customers.hierarchyHint')}</p>
    <div className="page-actions toolbar">
      {isAdmin && <button className="primary" disabled={loading} onClick={() => setEditor({ parentId: null })}>{t('customers.new')}</button>}
      <button onClick={() => setCollapsed(new Set())} disabled={loading || !items.length}>{t('customers.expandAll')}</button>
      <button onClick={() => setCollapsed(new Set(items.map((item) => item.id)))} disabled={loading || !items.length}>{t('customers.collapseAll')}</button>
    </div>
    {err && <div className="error hierarchy-error" role="alert">{err}<button onClick={() => setReload((value) => value + 1)}>{t('common.retry')}</button></div>}
    <div className="hierarchy-table-scroll">
      <table className="customer-tree-table">
        <thead><tr><th>{t('customers.colName')}</th><th>{t('customers.colCode')}</th><th>{t('customers.colDesc')}</th><th>{t('customers.colCreated')}</th><th>{t('customers.actions')}</th></tr></thead>
        <tbody>{visibleEntries.map(({ customer, depth, path }) => {
          const hasChildren = !!tree.children.get(customer.id)?.length;
          const expanded = !collapsed.has(customer.id);
          return <tr key={customer.id} data-customer-id={customer.id}>
            <td><div className="customer-tree-name" style={{ paddingLeft: Math.min(depth, 12) * 20 }}>
              {hasChildren ? <button className="customer-tree-toggle" aria-expanded={expanded} aria-label={t(expanded ? 'customers.collapse' : 'customers.expand', { name: customer.name })} onClick={() => setCollapsed((current) => {
                const next = new Set(current); if (next.has(customer.id)) next.delete(customer.id); else next.add(customer.id); return next;
              })}>{expanded ? '⌄' : '›'}</button> : <span className="customer-tree-spacer" />}
              <Link to={`/projects?customerId=${customer.id}`} title={path}>{customer.name}</Link>
            </div></td>
            <td><span className="code">{customer.code}</span></td>
            <td className="muted customer-tree-description">{customer.description || '—'}</td>
            <td className="muted customer-tree-date">{new Date(customer.createdAt).toLocaleDateString()}</td>
            <td>{isAdmin && <div className="customer-tree-actions">
              <button onClick={() => setEditor({ parentId: customer.id })} aria-label={t('customers.addChildTo', { name: customer.name })}>{t('customers.addChild')}</button>
              <button onClick={() => setEditor({ item: customer, parentId: customer.parentId })} aria-label={t('customers.editNamed', { name: customer.name })}>{t('customers.edit')}</button>
              <button className="danger" disabled={deleting !== null || hasChildren} title={hasChildren ? t('customers.removeChildrenFirst') : undefined} onClick={() => void remove(customer)}>{deleting === customer.id ? t('common.loading') : t('common.delete')}</button>
            </div>}</td>
          </tr>;
        })}{!visibleEntries.length && <tr><td colSpan={5} className="muted hierarchy-empty">{t(loading ? 'common.loading' : 'customers.empty')}</td></tr>}</tbody>
      </table>
    </div>
    {editor && <CustomerEditor customers={items} item={editor.item} initialParentId={editor.parentId} onClose={() => setEditor(null)} onSaved={(saved) => {
      setItems((current) => current.some((item) => item.id === saved.id) ? current.map((item) => item.id === saved.id ? saved : item) : [...current, saved]);
      setCollapsed((current) => { const next = new Set(current); if (saved.parentId !== null) next.delete(saved.parentId); return next; });
      setEditor(null);
    }} />}
  </>;
}

function CustomerEditor({ customers, item, initialParentId, onClose, onSaved }: {
  customers: Customer[]; item?: Customer; initialParentId: number | null; onClose: () => void; onSaved: (customer: Customer) => void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(item?.name ?? '');
  const [code, setCode] = useState(item?.code ?? '');
  const [codeEdited, setCodeEdited] = useState(false);
  const [description, setDescription] = useState(item?.description ?? '');
  const [parentId, setParentId] = useState<number | null>(initialParentId);
  const tree = useMemo(() => customerHierarchy(customers), [customers]);
  const excluded = item ? tree.descendants(item.id) : new Set<number>();
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || !name.trim()) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const saved = item
        ? await api.updateCustomer(item.id, { name: name.trim(), description: description.trim() || null, parentId })
        : await api.createCustomer({ name: name.trim(), code: code.trim() || undefined, description: description.trim() || undefined, parentId });
      onSaved(saved);
    } catch (failure: any) { setError(failure.message); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className="dialog hierarchy-dialog" aria-labelledby="customer-editor-title" onCancel={(event) => { event.preventDefault(); if (!busyRef.current) onClose(); }}>
    <form onSubmit={save}>
      <h3 id="customer-editor-title">{t(item ? 'customers.dlgEdit' : 'customers.dlgNew')}</h3>
      {error && <div className="error" role="alert">{error}</div>}
      <fieldset disabled={busy}>
        <label><span className="lbl">{t('customers.fldParent')}</span><select aria-label={t('customers.fldParent')} value={parentId ?? ''} onChange={(event) => setParentId(event.target.value ? Number(event.target.value) : null)}>
          <option value="">{t('customers.topLevel')}</option>{tree.entries.filter(({ customer }) => !excluded.has(customer.id)).map(({ customer, path }) => <option key={customer.id} value={customer.id}>{path} ({customer.code})</option>)}
        </select></label>
        <p className="muted hierarchy-field-hint">{t('customers.hierarchyHint')}</p>
        <label><span className="lbl">{t('customers.fldName')}</span><input value={name} onChange={(event) => { setName(event.target.value); if (!item && !codeEdited) setCode(slugify(event.target.value)); }} required autoFocus /></label>
        <label><span className="lbl">{t('customers.fldCode')}</span><input value={code} onChange={(event) => { setCode(event.target.value); setCodeEdited(true); }} readOnly={!!item} pattern="^[a-z0-9][a-z0-9_\-]{0,63}$" /></label>
        <label><span className="lbl">{t('customers.fldDesc')}</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></label>
      </fieldset>
      <div className="dialog-actions"><button type="button" onClick={onClose} disabled={busy}>{t('common.cancel')}</button><button type="submit" className="primary" disabled={busy}>{t(busy ? 'common.loading' : item ? 'common.save' : 'common.create')}</button></div>
    </form>
  </dialog>;
}
