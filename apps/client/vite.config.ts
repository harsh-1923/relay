import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = 'http://localhost:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  server: {
    port: 5173,
    // Proxying makes dev same-origin with the API, so the sealed session cookie behaves
    // exactly as it will in production. Without this, dev would need CORS and SameSite=None
    // that production never uses — divergence in the one place you cannot afford it.
    proxy: {
      '/auth': { target: API, changeOrigin: false },
      '/api': { target: API, changeOrigin: false },
    },
  },
});
