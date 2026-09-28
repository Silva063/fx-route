import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// PWA собирается из web/ в dist/. base './' — чтобы работать в подпапке GitHub Pages (user.github.io/repo/).
export default defineConfig({
  root: 'web',
  base: './',
  build: { outDir: '../dist', emptyOutDir: true },
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        name: 'Выгодный обмен ПМР ↔ Молдова',
        short_name: 'Обмен',
        description: 'Самый выгодный маршрут обмена валют через банки ПМР и Молдовы',
        lang: 'ru',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#f6f7f9',
        theme_color: '#1f6f5c',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Оболочка приложения (html/js/css/иконки) — precache, отдаётся из кеша («сначала кэш»);
        // данные — «сначала сеть, при неудаче кэш» (runtimeCaching ниже).
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            // config.json с сайта и rates.json — свой (data/) или из ветки data на raw.githubusercontent.com.
            urlPattern: ({ url }) => /\/data\/[^/]+\.json$/.test(url.pathname) || url.pathname.endsWith('/rates.json'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'fx-data',
              networkTimeoutSeconds: 6,
              expiration: { maxEntries: 10 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
});
