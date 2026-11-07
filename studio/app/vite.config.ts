import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../app-dist', emptyOutDir: true },
  server: { port: 5177, proxy: { '/api': 'http://127.0.0.1:4777', '/portraits': 'http://127.0.0.1:4777', '/village': 'http://127.0.0.1:4777' } },
});
