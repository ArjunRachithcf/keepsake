import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// HomersLab's design system, vendored unchanged (src/vendor/homerslab, README.md there), then Keepsake's own look.
import './vendor/homerslab/tokens.css';
import './vendor/homerslab/components.css';
import './vendor/homerslab/icons.js';
import './vendor/homerslab/motion.js';
import './keepsake.css';
import { App } from './App';
import { savedGlass, setGlass } from './motion';

// This device's glass level (the account sheet sets it): there at once, before the first paint glides anywhere.
setGlass(savedGlass(), false);

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

// The offline shell and the push handler (public/sw.js): never in development (Vite serves the sources), and only in a
// secure context (https, or localhost).
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined); });
}
