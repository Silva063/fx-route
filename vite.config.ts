import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/** Версия сборки: версия пакета, коммит (в GitHub Actions — GITHUB_SHA, локально — git), время. */
function commit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return dirty ? `${sha}+изм.` : sha;
  } catch {
    return 'dev';
  }
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

// PWA собирается из web/ в dist/. base './' — чтобы работать в подпапке GitHub Pages (user.github.io/repo/).
export default defineConfig({
  root: 'web',
  base: './',
  build: { outDir: '../dist', emptyOutDir: true },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(commit()),
    __APP_BUILT_AT__: JSON.stringify(new Date().toISOString()),
    __APP_REPO__: JSON.stringify(process.env.GITHUB_REPOSITORY ?? ''),
  },
  plugins: [
    preact(),
    VitePWA({
      // «По запросу»: новая версия ждёт, приложение показывает плашку «Доступна новая версия — обновить».
      registerType: 'prompt',
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
