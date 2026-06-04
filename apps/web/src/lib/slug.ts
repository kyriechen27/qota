import { pinyin } from 'pinyin-pro';

// Mirror of apps/worker/src/utils/slug.ts `slugify` so the live code preview in
// the UI matches what the backend would generate. Chinese → toneless pinyin.
//   "Acme Corp" → "acme-corp"   "盛浩" → "shenghao"   "金鹏 Tech" → "jinpeng-tech"
export function slugify(input: string): string {
  const romanized = pinyin(input, {
    toneType: 'none',
    separator: '',
    nonZh: 'consecutive',
    type: 'string',
  });
  return romanized
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
