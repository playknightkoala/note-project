import '@mantine/core/styles.css';
import '@mantine/dates/styles.css';
import '@blocknote/mantine/blocknoteStyles.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/editor.css';
import './styles/database.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { AppProviders } from './app/providers.tsx';
import { router } from './app/router.tsx';
import { registerOfflineShell } from './offline/register.ts';

registerOfflineShell();
createRoot(document.getElementById('root')!).render(<StrictMode><AppProviders><RouterProvider router={router} /></AppProviders></StrictMode>);
