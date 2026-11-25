import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
  // No inline assets: the CSP allows data: for pictures only, and the font is a file of its own.
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
});
