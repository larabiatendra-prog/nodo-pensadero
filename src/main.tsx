import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.tsx';
import './index.css';

// BrowserRouter (no Hash): URLs reales tipo /personas, /archivo/:id. El backend
// (server.js) y vite dev/preview sirven index.html en rutas profundas (fallback
// SPA), asi que un refresh directo o un deep-link funcionan. Single-origin →
// mismo host:puerto para app y API; vale localhost, 127.0.0.1 y pensadero.localhost.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
