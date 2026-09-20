/**
 * El volumen con el que se dejo el reproductor — Pensadero
 *
 * Vive fuera de los reproductores porque son dos: la tarjeta (MediaModal) y el
 * modo presentacion. Bajar el volumen en uno tiene que valer para el otro; si
 * no, cada pase arranca a todo trapo aunque acabes de bajarlo.
 */

const CLAVE = 'pensadero.volumenVideo';

/** Volumen con el que se dejo el reproductor. Sin nada guardado, al maximo. */
export function leerVolumen(): { volume: number; muted: boolean } {
  try {
    const crudo = localStorage.getItem(CLAVE);
    if (!crudo) return { volume: 1, muted: false };
    const dato = JSON.parse(crudo);
    const volume = typeof dato.volume === 'number' && dato.volume >= 0 && dato.volume <= 1
      ? dato.volume
      : 1;
    return { volume, muted: !!dato.muted };
  } catch {
    return { volume: 1, muted: false };
  }
}

export function guardarVolumen(volume: number, muted: boolean) {
  try {
    localStorage.setItem(CLAVE, JSON.stringify({ volume, muted }));
  } catch {
    // Navegacion privada o almacenamiento lleno: se pierde la preferencia y ya.
  }
}

/** "1:07", "12:03", "1:02:45". Para el tiempo de un clip. */
export function tiempoCorto(segundos: number): string {
  if (!isFinite(segundos) || segundos < 0) return '0:00';
  const s = Math.floor(segundos % 60);
  const m = Math.floor((segundos / 60) % 60);
  const h = Math.floor(segundos / 3600);
  const dos = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${dos(m)}:${dos(s)}` : `${m}:${dos(s)}`;
}
