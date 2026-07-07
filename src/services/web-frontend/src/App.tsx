import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './components/RequireAuth';
import { AppLayout } from './components/AppLayout';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { GoogleCompletePage } from './pages/GoogleCompletePage';
import { DashboardPage } from './pages/DashboardPage';
import { ValuationsPage } from './pages/ValuationsPage';
import { NewValuationPage } from './pages/NewValuationPage';
import { ValuationDetailPage } from './pages/ValuationDetailPage';
import { SettingsPage } from './pages/SettingsPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/auth/google/complete" element={<GoogleCompletePage />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/valuations" element={<ValuationsPage />} />
        <Route path="/valuations/new" element={<NewValuationPage />} />
        <Route path="/valuations/:id" element={<ValuationDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
