import AnnouncementBoard from '../components/AnnouncementBoard';
import { useI18n } from '../lib/i18n';

export default function Announcements() {
  const { t } = useI18n();
  return (
    <div className="announcements-page">
      <div className="announcements-page-heading"><h2 className="page-title">{t('ann.title')}</h2><p>{t('ann.subtitle')}</p></div>
      <AnnouncementBoard />
    </div>
  );
}
