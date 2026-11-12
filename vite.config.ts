import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  define: {
    // bc-ur and its CJS dependencies expect Node-style globals.
    global: 'globalThis',
    'process.env': '{}',
  },
  resolve: {
    // `assert` is a Node builtin but bc-ur uses it at runtime; point it at the
    // pure-JS npm shim that bc-ur installs as its own dependency.
    alias: [{ find: /^assert$/, replacement: 'assert/' }],
  },
  optimizeDeps: {
    include: ['@ngraveio/bc-ur', 'buffer'],
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'],
      manifest: {
        name: 'UR Scanner — Blockchain Commons',
        short_name: 'UR Scanner',
        description:
          'Scan animated Uniform Resource (UR) QR codes from air-gapped wallets. Runs entirely on your device.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#0b0f14',
        theme_color: '#0b0f14',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        navigateFallback: 'index.html',
      },
    }),
  ],
});
