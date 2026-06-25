import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    // Prevent Vite from inlining icons as data URLs — chrome.action.setIcon
    // requires a real extension-root-relative path, not a data: URI.
    assetsInlineLimit: (filePath) => filePath.includes('/icons/') ? 0 : 4096,
    rollupOptions: {
      // Pages opened at runtime via chrome.tabs.create() are not referenced
      // from the manifest, so declare them as explicit entry points.
      input: {
        logger: 'logger.html',
        robots: 'robots.html',
      },
    },
  },
  // CRXJS uses a dedicated port for its HMR websocket in dev.
  server: { port: 5173, strictPort: true },
});
