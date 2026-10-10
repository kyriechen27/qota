import type { Customer } from '@qota/shared';

/** Build paths exclusively from visible customers; missing ancestors are local roots. */
export function customerHierarchy(customers: Customer[]) {
  const byId = new Map(customers.map((customer) => [customer.id, customer]));
  const children = new Map<number | null, Customer[]>();
  for (const customer of customers) {
    const parent = customer.parentId != null && customer.parentId !== customer.id && byId.has(customer.parentId)
      ? customer.parentId : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(customer);
    children.set(parent, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.id - b.id);
  const entries: { customer: Customer; depth: number; path: string; parentId: number | null }[] = [];
  const paths = new Map<number, string>();
  const visited = new Set<number>();
  function visit(customer: Customer, depth: number, prefix: string, parentId: number | null) {
    if (visited.has(customer.id)) return;
    visited.add(customer.id);
    const path = prefix ? `${prefix}-${customer.name}` : customer.name;
    entries.push({ customer, depth, path, parentId });
    paths.set(customer.id, path);
    for (const child of children.get(customer.id) ?? []) visit(child, depth + 1, path, customer.id);
  }
  for (const customer of children.get(null) ?? []) visit(customer, 0, '', null);
  // A malformed cycle must neither hide records nor cause infinite recursion.
  for (const customer of customers) if (!visited.has(customer.id)) visit(customer, 0, '', null);
  function descendants(id: number) {
    const ids = new Set<number>([id]);
    const queue = [id];
    for (let i = 0; i < queue.length; i++) {
      for (const child of children.get(queue[i]!) ?? []) {
        if (!ids.has(child.id)) { ids.add(child.id); queue.push(child.id); }
      }
    }
    return ids;
  }
  return { entries, paths, children, descendants };
}
