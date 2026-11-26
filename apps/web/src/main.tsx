import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './app.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

// The offline shell and the push handler (public/sw.js): never in development (Vite serves the sources), and only in a
// secure context (https, or localhost).
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined); });
}
