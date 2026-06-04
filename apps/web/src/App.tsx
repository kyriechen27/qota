import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import Login from './pages/Login';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Customers from './pages/Customers';
import Projects from './pages/Projects';
import ProjectDetail from './pages/ProjectDetail';
import Files from './pages/Files';
import Users from './pages/Users';
import Permissions from './pages/Permissions';
import Account from './pages/Account';
import LangSwitch from './components/LangSwitch';

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <>
        <div style={{ padding: 24 }}>Loading…</div>
        <LangSwitch />
      </>
    );
  }

  if (!user) {
    return (
      <>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
        <LangSwitch />
      </>
    );
  }

  return (
    <>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:id" element={<ProjectDetail />} />
          <Route path="/files" element={<Files />} />
          {user.role === 'super_admin' && (
            <>
              <Route path="/users" element={<Users />} />
              <Route path="/permissions" element={<Permissions />} />
            </>
          )}
          <Route path="/account" element={<Account />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
      <LangSwitch />
    </>
  );
}
