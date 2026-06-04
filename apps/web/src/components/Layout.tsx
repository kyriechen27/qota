import { NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';

export default function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  if (!user) return null;
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">📦 qota</div>
        <NavLink to="/" end className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
          {t('nav.dashboard')}
        </NavLink>
        <NavLink to="/customers" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
          {t('nav.customers')}
        </NavLink>
        <NavLink to="/projects" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
          {t('nav.projects')}
        </NavLink>
        <NavLink to="/files" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
          {t('nav.files')}
        </NavLink>
        {user.role === 'super_admin' && (
          <>
            <NavLink to="/users" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
              {t('nav.users')}
            </NavLink>
            <NavLink to="/permissions" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
              {t('nav.memberships')}
            </NavLink>
          </>
        )}
        <div className="spacer" />
        <NavLink to="/account" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
          {t('nav.account')}
        </NavLink>
        <div className="user-box">
          <div>{user.displayName || user.email}</div>
          <div className="email">
            {user.email} <span className={`tag ${user.role}`}>{t(`role.${user.role}`)}</span>
          </div>
          <button onClick={logout}>{t('nav.signout')}</button>
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
