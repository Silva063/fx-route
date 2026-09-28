import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';
import { App } from './app';
import './style.css';

render(<App />, document.getElementById('app')!);

// Service worker: приложение работает офлайн на последних сохранённых курсах.
if ('serviceWorker' in navigator) registerSW({ immediate: true });
