/**
 * Los dos apartados de Tomas gemelas. Son problemas distintos y por eso van
 * separados: las PARECIDAS son archivos distintos y se elige cual vale mas;
 * las COPIAS EXACTAS son el mismo archivo y solo se elige donde se queda.
 */

export type ApartadoGemelas = 'parecidas' | 'copias';

interface Props {
  activo: ApartadoGemelas;
  onCambiar: (a: ApartadoGemelas) => void;
  /** Copias pendientes de decidir, para que se vea sin entrar. */
  pendientesCopias?: number;
}

export default function PestanasGemelas({ activo, onCambiar, pendientesCopias }: Props) {
  const pestana = (id: ApartadoGemelas, texto: string, extra?: number) => (
    <button
      role="tab"
      aria-selected={activo === id}
      onClick={() => onCambiar(id)}
      className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full text-sm transition-colors ${
        activo === id ? 'bg-lavanda text-noche font-medium' : 'text-niebla hover:text-marfil hover:bg-pizarra'
      }`}
    >
      {texto}
      {typeof extra === 'number' && extra > 0 && (
        <span className={`px-1.5 rounded-full text-[11px] font-mono tabular-nums ${
          activo === id ? 'bg-noche/15' : 'bg-pizarra text-lavanda'
        }`}>
          {extra}
        </span>
      )}
    </button>
  );
  return (
    <div role="tablist" aria-label="Apartados de Tomas gemelas" className="inline-flex gap-1 p-1 mb-4 rounded-full bg-grafito/60">
      {pestana('parecidas', 'Parecidas')}
      {pestana('copias', 'Copias exactas', pendientesCopias)}
    </div>
  );
}
