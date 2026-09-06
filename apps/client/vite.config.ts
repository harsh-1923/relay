import basicSsl from '@vitejs/plugin-basic-ssl';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = 'http://localhost:8787';

export default defineConfig({
  /**
   * `RELAY_HTTPS=1 pnpm dev` serves HTTPS — not for security, for HTTP/2.
   *
   * A room holds five shapes, each an open long-poll, and HTTP/1.1 allows ~6 connections per
   * origin. One room plus `actors` exhausts that, so a second room deadlocks the first;
   * Electric warns about exactly this in the console. HTTP/2 multiplexes them onto one
   * connection, which is what makes "subscriptions independent of what is rendered" possible.
   *
   * Opt-in rather than default because a self-signed certificate costs a trust prompt in the
   * browser and a Chromium switch in the Electron shell, and the wall only appears with two
   * rooms open. Flip it on to work on multi-room behaviour; production is HTTP/2 regardless.
   */
  plugins: [react(), tailwindcss(), ...(process.env.RELAY_HTTPS ? [basicSsl()] : [])],
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  server: {
    port: 5173,
    // Proxying makes dev same-origin with the API, so the sealed session cookie behaves
    // exactly as it will in production. Without this, dev would need CORS and SameSite=None
    // that production never uses — divergence in the one place you cannot afford it.
    proxy: {
      '/auth': { target: API, changeOrigin: false },
      '/api': { target: API, changeOrigin: false },
      // Shapes long-poll, so the proxy must not time them out at its default.
      '/shapes': { target: API, changeOrigin: false, timeout: 0, proxyTimeout: 0 },
    },
  },
});
