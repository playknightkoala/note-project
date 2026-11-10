import { createBrowserRouter, Navigate } from 'react-router';
import { LoginPage } from '../features/auth/LoginPage.tsx';
import { RegisterPage } from '../features/auth/RegisterPage.tsx';
import { RequireAuth } from '../features/auth/RequireAuth.tsx';
import { AppShell } from '../features/shell/AppShell.tsx';
import { HomePage } from '../features/shell/HomePage.tsx';
import { SettingsPage } from '../features/settings/SettingsPage.tsx';
import { PageRoute } from '../features/page/PageRoute.tsx';
import { TrashPage } from '../features/trash/TrashPage.tsx';
import { RouteError } from './RouteError.tsx';
import { PublicView } from '../features/share/PublicView.tsx';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage />, errorElement: <RouteError /> },
  { path: '/register', element: <RegisterPage />, errorElement: <RouteError /> },
  // A public link: outside the sign-in gate and the app shell, so nothing on it asks for the visitor's account.
  { path: '/s/:token', element: <PublicView />, errorElement: <RouteError /> },
  { path: '/s/:token/:pageId', element: <PublicView />, errorElement: <RouteError /> },
  {
    path: '/',
    element: <RequireAuth><AppShell /></RequireAuth>,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'p/:pageId', element: <PageRoute /> },
      { path: 'trash', element: <TrashPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);
