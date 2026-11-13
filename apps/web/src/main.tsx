import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { reloadForNewBuild } from './lib/lazy-reload';
import './styles.css';

// Vite reports a part of an older build that is gone (a tab opened before an update): reload once.
window.addEventListener('vite:preloadError', (event) => { if (reloadForNewBuild()) event.preventDefault(); });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
