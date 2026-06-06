import { useState, useEffect } from 'react';
import { User } from 'lucide-react';

/**
 * Avatar reutilizable para personas. Mejora sobre el <img> suelto que habia en
 * PersonsManager:
 *  - Fallback: si la imagen falla (404, HEIC no renderizable, recorte EXIF roto)
 *    NO muestra el glifo de imagen rota del navegador; cae a las INICIALES del
 *    nombre, o al icono de usuario si no hay nombre.
 *  - Cache-bust: el avatar.jpg se sobrescribe en el mismo path al cambiarlo, asi
 *    que el navegador mostraba el viejo. Con `bust` (un token que el padre cambia
 *    al actualizar el avatar) se fuerza recarga sin desactivar el cache normal.
 *
 * El contenedor (forma/tamaño/anillo) lo pone el padre; este componente solo
 * rellena su interior (w-full h-full).
 */

function initialsOf(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

interface AvatarProps {
  url: string | null;
  name: string;
  bust?: string | number;
  iconClassName?: string;
}

export default function Avatar({ url, name, bust, iconClassName = 'w-7 h-7' }: AvatarProps) {
  const [broken, setBroken] = useState(false);
  // Resetear el estado "roto" si cambia la fuente o el token de cache-bust.
  useEffect(() => { setBroken(false); }, [url, bust]);

  const src = url
    ? (bust != null ? `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(String(bust))}` : url)
    : null;

  if (src && !broken) {
    return (
      <img
        src={src}
        alt={name}
        className="w-full h-full object-cover"
        loading="lazy"
        onError={() => setBroken(true)}
      />
    );
  }

  const initials = initialsOf(name);
  return (
    <div className="w-full h-full flex items-center justify-center bg-grafito">
      {initials
        ? <span className="text-lavanda-archivo font-semibold select-none">{initials}</span>
        : <User className={`${iconClassName} text-lavanda-archivo`} />}
    </div>
  );
}
