/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** Подставляются при сборке (vite.config.ts → define). */
declare const __APP_VERSION__: string;
/** Короткий хеш коммита или 'dev'. */
declare const __APP_COMMIT__: string;
declare const __APP_BUILT_AT__: string;
/** owner/repo на GitHub или ''. */
declare const __APP_REPO__: string;
