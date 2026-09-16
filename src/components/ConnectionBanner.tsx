import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

/**
 * Aviso de estado del backend.
 *
 * Existe porque cuando el backend se caia la app no lo decia: la pantalla se
 * quedaba congelada con el ultimo estado recibido y no habia forma de
 * distinguir "esta trabajando" de "esta muerto". El 07/09/2026 estuvo asi casi
 * dos horas. El hook useWebSocket ya reconectaba solo cada 5 s; lo unico que
 * faltaba era contarlo.
 *
 * Tambien avisa al recuperar la conexion, porque un corte y vuelta significa
 * que el backend se reinicio y puede haber trabajo a medias.
 */
interface ConnectionBannerProps {
  isConnected: boolean;
}

/** Margen antes de dar la conexion por perdida. */
const MARGEN_MS = 4000;

export function ConnectionBanner({ isConnected }: ConnectionBannerProps) {
  // Solo cuenta como corte una desconexion que dura mas que el margen. Al
  // cargar la pagina el socket tarda un instante en abrir: antes eso pintaba
  // "Sin conexion" y a continuacion "Conexion restablecida. Hubo un corte" en
  // CADA carga, y un aviso que salta siempre deja de leerse justo el dia que
  // importa.
  const huboCorte = useRef(false);
  const [caido, setCaido] = useState(false);
  const [mostrarRecuperado, setMostrarRecuperado] = useState(false);

  useEffect(() => {
    if (!isConnected) {
      setMostrarRecuperado(false);
      const t = setTimeout(() => {
        huboCorte.current = true;
        setCaido(true);
      }, MARGEN_MS);
      return () => clearTimeout(t);
    }
    setCaido(false);
    if (huboCorte.current) {
      huboCorte.current = false;
      setMostrarRecuperado(true);
      const t = setTimeout(() => setMostrarRecuperado(false), 8000);
      return () => clearTimeout(t);
    }
  }, [isConnected]);

  if (!isConnected && caido) {
    return (
      <div
        role="status"
        className="fixed top-0 inset-x-0 z-[200] flex items-center justify-center gap-3 px-4 py-2.5 bg-melocoton text-noche shadow-lg"
      >
        <AlertTriangle className="w-4 h-4 shrink-0" />
        <span className="text-sm font-medium">
          Sin conexion con el backend. Reintentando cada 5 segundos...
        </span>
        <span className="hidden sm:inline text-xs opacity-75">
          Si no vuelve, revisa la ventana de Pensadero o el log en backend\logs
        </span>
      </div>
    );
  }

  if (mostrarRecuperado) {
    return (
      <div
        role="status"
        className="fixed top-0 inset-x-0 z-[200] flex items-center justify-center gap-3 px-4 py-2.5 bg-salvia text-noche shadow-lg"
      >
        <CheckCircle2 className="w-4 h-4 shrink-0" />
        <span className="text-sm font-medium">
          Conexion restablecida. Hubo un corte: si habia un escaneo en marcha, comprueba si sigue.
        </span>
      </div>
    );
  }

  return null;
}
