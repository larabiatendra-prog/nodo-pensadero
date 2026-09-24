// Quien puede hablar con Pensadero desde un navegador.
//
// No hay auth: la defensa es que solo lleguen peticiones hechas desde el propio
// Pensadero. Dos trucos que hay que parar:
//  - Otra web llamando a la API (CSRF) o abriendo el WebSocket, que no pasa
//    por CORS: lo delata el Origin.
//  - DNS rebinding: una web hace que SU dominio apunte a 127.0.0.1 y sus
//    peticiones pasan a ser "del mismo origen" (Origin y Host son los suyos),
//    asi que puede leerlo todo. Lo que la delata es el Host: a Pensadero se
//    llega por un nombre local o por una IP, nunca por un dominio ajeno.
const net = require('net');
const os = require('os');

const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

// Nombres propios para entrar desde la red (HOST=0.0.0.0): el del equipo y los
// que se pongan en HOSTS_PERMITIDOS del .env (p. ej. el de la VPN), separados por comas.
function hostsExtra() {
  return new Set(
    [os.hostname(), ...String(process.env.HOSTS_PERMITIDOS || '').split(',')]
      .map(h => h.trim().toLowerCase()).filter(Boolean)
  );
}
const EXTRA = hostsExtra();

function nombreDeHost(host) {
  try { return new URL(`http://${host}`).hostname.toLowerCase(); } catch { return null; }
}

/** ¿La cabecera Host es de las que llegan a este PC sin pasar por un dominio ajeno? */
function hostPermitido(host, extra = EXTRA) {
  if (!host) return true; // sin Host no es un navegador
  const nombre = nombreDeHost(host);
  if (!nombre) return false;
  if (nombre === 'localhost' || nombre.endsWith('.localhost')) return true;
  // Una IP escrita tal cual no se puede redirigir con DNS.
  if (net.isIP(nombre.replace(/^\[|\]$/g, ''))) return true;
  return extra.has(nombre);
}

/** ¿La peticion viene del propio Pensadero (mismo host) o del Vite de desarrollo? */
function origenPermitido(origin, host) {
  if (!origin) return true; // navegacion normal, <video>, curl
  if (LOCAL_ORIGIN_RE.test(origin)) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

module.exports = { LOCAL_ORIGIN_RE, hostPermitido, origenPermitido };
