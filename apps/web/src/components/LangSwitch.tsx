import { useI18n, type Lang } from '../lib/i18n';

export default function LangSwitch() {
  const { lang, setLang } = useI18n();
  return (
    <div className="lang-switch-fixed">
      <span aria-hidden>🌐</span>
      <select aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
        <option value="zh">中文</option>
        <option value="en">English</option>
      </select>
    </div>
  );
}
