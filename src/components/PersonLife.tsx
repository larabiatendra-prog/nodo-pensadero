import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Images } from 'lucide-react';
import config from '../config';
import type { MediaFile, Person } from '../types';
import { getFileSortDate, getSessionLabelSource } from '../utils/filenameParser';

/**
 * Linea de vida de una persona.
 *
 * Todas sus apariciones en orden, de la mas antigua a la ultima, agrupadas por
 * año. No es un buscador ni un panel: es una tira de imagenes con una linea de
 * tiempo al lado, para ver a alguien atravesar el archivo.
 *
 * La fecha es la misma que usa la galeria (`getFileSortDate`): la del nombre o
 * la de la carpeta antes que la del disco, porque una carpeta retocada en 2026
 * sigue siendo del dia que se grabo.
 */

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

interface Props {
  personId: string;
  files: MediaFile[];
  onBack: () => void;
  onSelectFile: (file: MediaFile) => void;
  /** Abre la galeria filtrada por esta persona. */
  onVerEnGaleria?: (personId: string) => void;
}

/** "septiembre de 2019" a partir de un YYYYMMDD. */
function mesYAnio(fecha: number): string {
  const anio = Math.floor(fecha / 10000);
  const mes = Math.floor((fecha % 10000) / 100);
  if (!anio || mes < 1 || mes > 12) return String(anio || '');
  return `${MESES[mes - 1]} de ${anio}`;
}

export default function PersonLife({ personId, files, onBack, onSelectFile, onVerEnGaleria }: Props) {
  const [persona, setPersona] = useState<Person | null>(null);
  const [avatarRoto, setAvatarRoto] = useState(false);

  useEffect(() => {
    let cancelado = false;
    fetch(`${config.apiBaseUrl}/persons`)
      .then(r => r.json())
      .then(j => {
        if (cancelado || !j || !Array.isArray(j.data)) return;
        setPersona(j.data.find((p: Person) => p.person_id === personId) || null);
      })
      .catch(() => { /* sin avatar: caemos a las iniciales */ });
    return () => { cancelado = true; };
  }, [personId]);

  // Sus archivos, del mas antiguo al mas reciente.
  const suyos = useMemo(() => files
    .filter(f => (f.faces || []).some(c => c.person_id === personId))
    .map(f => ({ file: f, fecha: getFileSortDate(f) }))
    .sort((a, b) => a.fecha - b.fecha),
    [files, personId]);

  // El nombre sale de las propias detecciones: no depende de que cargue la API.
  const nombre = persona?.display_name
    || suyos[0]?.file.faces?.find(c => c.person_id === personId)?.display_name
    || personId;

  const { anios, maximo, sinFecha } = useMemo(() => {
    const mapa = new Map<number, Array<{ file: MediaFile; fecha: number }>>();
    const sueltos: Array<{ file: MediaFile; fecha: number }> = [];
    for (const item of suyos) {
      if (!item.fecha) { sueltos.push(item); continue; }
      const anio = Math.floor(item.fecha / 10000);
      const arr = mapa.get(anio);
      if (arr) arr.push(item); else mapa.set(anio, [item]);
    }
    const lista = [...mapa.entries()].sort((a, b) => a[0] - b[0]);
    const max = lista.reduce((m, [, arr]) => Math.max(m, arr.length), 0);
    return { anios: lista, maximo: max || 1, sinFecha: sueltos };
  }, [suyos]);

  const conFecha = suyos.filter(s => s.fecha > 0);
  const primera = conFecha[0]?.fecha;
  const ultima = conFecha[conFecha.length - 1]?.fecha;

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-1 px-3 py-1.5 mb-6 text-sm font-medium text-lavanda hover:text-noche hover:bg-lavanda rounded-lg transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Volver</span>
      </button>

      {/* Cabecera: quien es y cuanto archivo atraviesa */}
      <div className="flex items-center gap-4 mb-8">
        {persona?.avatar_url && !avatarRoto ? (
          <img
            src={`${config.apiUrl}${persona.avatar_url}`}
            alt=""
            className="w-16 h-16 rounded-full object-cover border border-pizarra"
            onError={() => setAvatarRoto(true)}
          />
        ) : (
          <div className="w-16 h-16 rounded-full bg-pizarra text-lavanda flex items-center justify-center text-xl font-semibold">
            {nombre.trim().slice(0, 2).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-marfil leading-tight">{nombre}</h1>
          <p className="text-sm text-niebla mt-1">
            {suyos.length} {suyos.length === 1 ? 'archivo' : 'archivos'}
            {primera && ultima && primera !== ultima && (
              <> · de {mesYAnio(primera)} a {mesYAnio(ultima)}</>
            )}
            {primera && ultima && primera === ultima && <> · {mesYAnio(primera)}</>}
          </p>
        </div>
        {onVerEnGaleria && suyos.length > 0 && (
          <button
            onClick={() => onVerEnGaleria(personId)}
            className="ml-auto flex items-center gap-2 px-3 py-1.5 rounded-full text-sm bg-pizarra text-niebla hover:text-marfil hover:bg-grafito transition-colors"
            title="Filtrar la galeria por esta persona"
          >
            <Images className="w-4 h-4" />
            Ver en la galería
          </button>
        )}
      </div>

      {suyos.length === 0 && (
        <p className="text-niebla">Todavía no hay archivos identificados con esta persona.</p>
      )}

      {/* La linea: un año por fila, con su tira de imagenes */}
      <div className="space-y-6">
        {anios.map(([anio, items]) => (
          <div key={anio} className="flex gap-4 md:gap-6">
            <div className="w-14 md:w-16 shrink-0 text-right pt-0.5">
              <div className="font-mono text-lg text-lavanda leading-none">{anio}</div>
              <div className="text-[11px] font-mono text-humo mt-1">{items.length}</div>
              {/* Barra: cuanto pesa este año frente al mas cargado */}
              <div className="mt-2 h-1 w-full rounded-full bg-pizarra overflow-hidden">
                <div
                  className="h-full rounded-full bg-lavanda-archivo"
                  style={{ width: `${Math.max(6, (items.length / maximo) * 100)}%` }}
                />
              </div>
            </div>

            <div className="flex-1 min-w-0 border-l border-pizarra pl-4 md:pl-6">
              <div className="flex flex-wrap gap-2">
                {items.map(({ file, fecha }) => (
                  <button
                    key={file.id}
                    onClick={() => onSelectFile(file)}
                    title={`${getSessionLabelSource(file) || file.name} · ${mesYAnio(fecha)}`}
                    className="group relative w-20 h-20 md:w-24 md:h-24 rounded-lg overflow-hidden bg-grafito focus:outline-none focus-visible:ring-2 focus-visible:ring-lavanda"
                  >
                    <img
                      src={file.thumbnail}
                      alt=""
                      loading="lazy"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    />
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-noche to-transparent opacity-0 group-hover:opacity-100 transition-opacity p-1">
                      <span className="block text-[10px] font-mono text-marfil truncate">
                        {MESES[Math.floor((fecha % 10000) / 100) - 1]?.slice(0, 3) || ''}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ))}

        {sinFecha.length > 0 && (
          <div className="flex gap-4 md:gap-6">
            <div className="w-14 md:w-16 shrink-0 text-right pt-0.5">
              <div className="font-mono text-xs text-humo leading-none uppercase">sin fecha</div>
              <div className="text-[11px] font-mono text-humo mt-1">{sinFecha.length}</div>
            </div>
            <div className="flex-1 min-w-0 border-l border-pizarra pl-4 md:pl-6">
              <div className="flex flex-wrap gap-2">
                {sinFecha.map(({ file }) => (
                  <button
                    key={file.id}
                    onClick={() => onSelectFile(file)}
                    title={file.name}
                    className="group relative w-20 h-20 md:w-24 md:h-24 rounded-lg overflow-hidden bg-grafito"
                  >
                    <img
                      src={file.thumbnail}
                      alt=""
                      loading="lazy"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    />
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
