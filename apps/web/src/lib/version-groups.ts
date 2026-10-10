import type { Version } from '@qota/shared';

/** A release belongs to one project, even when another project uses the same version label. */
export function groupVersions<T extends Version>(versions: T[]) {
  const groups = new Map<string, T[]>();
  for (const version of versions) {
    const key = JSON.stringify([version.projectId, version.version]);
    const items = groups.get(key);
    if (items) items.push(version);
    else groups.set(key, [version]);
  }

  return [...groups.entries()].flatMap(([key, items]) => {
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
      key,
      projectId: first.projectId,
      label: first.version,
      items: sortedItems,
      latest,
      channels,
      statusCounts,
      totalSize: items.reduce((sum, item) => sum + item.size, 0),
      totalDownloads: items.reduce((sum, item) => sum + item.downloadCount, 0),
      hasCurrent: items.some((item) => item.isCurrent),
      hasReady: items.some((item) => item.status === 'ready'),
      hasPublic: items.some((item) => item.publicSlug),
    };
  }).sort((a, b) => Number(b.hasCurrent) - Number(a.hasCurrent) || b.latest.createdAt - a.latest.createdAt);
}
