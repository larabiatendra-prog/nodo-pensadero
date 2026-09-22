import toast from 'react-hot-toast';
import { api } from '../services/api';

/**
 * Copias exactas: lo que comparten el aviso de la home y su vista de revision.
 * Criterio completo en backend/services/copiasExactas.js.
 */

/** "Tienes 30 archivos duplicados", con el singular bien. */
export function textoDuplicados(n: number): string {
  return n === 1 ? 'Tienes 1 archivo duplicado' : `Tienes ${n.toLocaleString('es-ES')} archivos duplicados`;
}

/**
 * "Limpiar automaticamente": cada grupo pendiente se queda con la copia que
 * propone el sistema. El aviso lleva un "deshacer" que solo quita lo que
 * decidio ESTA limpieza: lo que cambies a mano despues se respeta.
 *
 * Devuelve true si se hizo algo. Los fallos salen en un aviso, nunca callados.
 */
export async function limpiarCopiasConDeshacer(alTerminar?: () => void): Promise<boolean> {
  try {
    const r = await api.limpiarCopias();
    if (!r.success || !r.data) throw new Error('no se pudo limpiar');
    const { escondidas, grupos, huellas, lote } = r.data;
    if (grupos === 0) {
      toast('No quedaba ninguna copia por decidir.');
      alTerminar?.();
      return false;
    }
    toast.success(
      (t) => (
        <span className="flex items-center gap-3">
          {escondidas === 1 ? '1 copia escondida' : `${escondidas} copias escondidas`}. No se ha borrado nada.
          <button
            onClick={async () => {
              toast.dismiss(t.id);
              try {
                await api.olvidarCopias(huellas, lote);
                toast.success('Deshecho: vuelven a verse.');
              } catch (err) {
                toast.error(`No se pudo deshacer: ${err instanceof Error ? err.message : 'error de red'}`);
              }
              alTerminar?.();
            }}
            className="px-2 py-0.5 rounded-full text-xs font-medium bg-pizarra text-lavanda hover:text-marfil"
          >
            Deshacer
          </button>
        </span>
      ),
      { duration: 8000 },
    );
    alTerminar?.();
    return true;
  } catch (err) {
    toast.error(`No se pudo limpiar: ${err instanceof Error ? err.message : 'error de red'}`);
    return false;
  }
}
