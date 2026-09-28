import { render } from 'preact';
import { App } from './app';
import './style.css';
import { initUpdates } from './update';

render(<App />, document.getElementById('app')!);

// Service worker: офлайн-работа и проверка новой версии (плашка «Доступна новая версия»).
initUpdates();
