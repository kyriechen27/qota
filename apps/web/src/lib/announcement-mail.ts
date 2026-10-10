import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Announcement } from '@qota/shared';
import { api } from './api';

// Boards can share a request while routes change. The server also claims each recipient.
const requests = new Map<number, Promise<Announcement>>();
function sendBatch(id: number, retryFailed: boolean) {
  const existing = requests.get(id);
  if (existing) return existing;
  const request = api.retryAnnouncementMail(id, retryFailed).finally(() => { requests.delete(id); });
  requests.set(id, request);
  return request;
}

export function useAnnouncementMail(items: Announcement[], setItems: Dispatch<SetStateAction<Announcement[]>>, stalledMessage: string) {
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const mounted = useRef(true);
  const processing = useRef(false);
  const paused = useRef(new Set<number>());
  const [sendingId, setSendingId] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<number, string>>({});

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function run(manual?: Announcement) {
    if (processing.current) return;
    processing.current = true;
    let first = manual;
    try {
      while (mounted.current) {
        const item = first ?? itemsRef.current.find((entry) => entry.canEdit && (entry.mail?.pending ?? 0) > 0 && !paused.current.has(entry.id));
        if (!item) break;
        const retryFailed = Boolean(first);
        first = undefined;
        paused.current.delete(item.id);
        setSendingId(item.id);
        setErrors((current) => { const next = { ...current }; delete next[item.id]; return next; });
        try {
          const updated = await sendBatch(item.id, retryFailed);
          if (!mounted.current) break;
          itemsRef.current = itemsRef.current.map((entry) => entry.id === updated.id ? updated : entry);
          setItems(itemsRef.current);
          const before = item.mail;
          const after = updated.mail;
          if (after?.pending > 0 && before && after.pending >= before.pending
            && after.sent <= before.sent && after.failed <= before.failed && after.skipped <= before.skipped) {
            paused.current.add(item.id);
            setErrors((current) => ({ ...current, [item.id]: stalledMessage }));
          }
        } catch (e: any) {
          if (!mounted.current) break;
          paused.current.add(item.id);
          setErrors((current) => ({ ...current, [item.id]: e?.message ?? String(e) }));
        }
      }
    } finally {
      processing.current = false;
      if (mounted.current) setSendingId(null);
    }
  }

  useEffect(() => { void run(); }, [items]);
  return { sendingId, errors, retry: (item: Announcement) => { void run(item); } };
}
