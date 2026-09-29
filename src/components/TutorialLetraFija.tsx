/**
 * Mini tutorial: una letra fija para cada disco — Pensadero
 *
 * Cuando Windows cambia o cruza las letras de los discos, Pensadero no puede
 * arreglarlo por su cuenta: la letra es un ajuste de Windows. Esto lo explica
 * paso a paso con los discos de verdad (su nombre y su letra, tal como salen en
 * Administracion de discos) y al final comprueba donde han quedado. Las letras
 * que propone salen de utils/letrasDiscos.ts.
 */
import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { DiscoAFijar } from '../utils/letrasDiscos';

interface Props {
  discos: DiscoAFijar[];
  abierto: boolean;
  onAlternar: () => void;
  onComprobar: () => void;
  comprobando: boolean;
}

const Tecla = ({ children }: { children: ReactNode }) => (
  <kbd className="px-1.5 py-px rounded border border-pizarra bg-grafito text-marfil font-sans text-[10px]">{children}</kbd>
);

/** Lo que el usuario ve escrito en Windows: se pinta igual para reconocerlo. */
const Pantalla = ({ children }: { children: ReactNode }) => <b className="text-marfil font-medium">{children}</b>;

/** Como sale en la lista de Administracion de discos: "Nombre (G:)". */
const enLaLista = (d: DiscoAFijar) => `${d.etiqueta ? `${d.etiqueta} ` : ''}(${d.letraAhora})`;

export default function TutorialLetraFija({ discos, abierto, onAlternar, onComprobar, comprobando }: Props) {
  if (discos.length === 0) return null;
  const [primero, ...resto] = discos;
  const varios = discos.length > 1;

  return (
    <div className="basis-full">
      <button
        onClick={onAlternar}
        aria-expanded={abierto}
        className="flex items-start gap-1 text-left text-[11px] text-lavanda hover:text-lavanda-claro transition-colors"
      >
        <ChevronRight className={`w-3.5 h-3.5 mt-px shrink-0 transition-transform duration-200 ${abierto ? 'rotate-90' : ''}`} />
        Para que no vuelva a pasar: {varios ? 'dale a cada disco su letra fija' : 'dale al disco una letra fija'} (paso a paso, 2 minutos)
      </button>

      {abierto && (
        <div className="mt-2 rounded-lg bg-noche/40 px-3 py-2.5 text-[12px] text-niebla leading-relaxed">
          <p className="text-[11px] text-humo">
            Windows reparte las letras según el orden en que conectas los discos, y a veces se las cruza. Se arregla en
            Windows, no en Pensadero. No se borra ni se mueve nada: solo cambia la letra.
          </p>
          <ol className="mt-2 space-y-1.5 list-decimal pl-5 marker:text-humo">
            <li>
              Cierra lo que tenga abierto algo de {varios ? 'esos discos' : 'ese disco'} (una carpeta del Explorador, un
              editor de vídeo…). Pensadero puede seguir abierto.
            </li>
            <li>
              Pulsa <Tecla>Win</Tecla> + <Tecla>X</Tecla> (o clic derecho en el botón de Inicio) y elige{' '}
              <Pantalla>Administración de discos</Pantalla>.
            </li>
            <li>
              En la lista de arriba, clic derecho en <Pantalla>{enLaLista(primero)}</Pantalla> →{' '}
              <Pantalla>Cambiar la letra y rutas de acceso de unidad…</Pantalla>
            </li>
            <li>
              Con <Pantalla>{primero.letraAhora}</Pantalla> seleccionada, pulsa <Pantalla>Cambiar…</Pantalla> y, en
              la ventana nueva, deja marcado «Asignar la letra de unidad siguiente», elige{' '}
              <Pantalla>{primero.letraNueva}</Pantalla> en el desplegable y pulsa <Pantalla>Aceptar</Pantalla>.
            </li>
            <li>
              Windows avisa de que algunos programas podrían no funcionar bien: pulsa <Pantalla>Sí</Pantalla>.
            </li>
            {resto.map(d => (
              <li key={d.letraAhora}>
                Haz lo mismo con <Pantalla>{enLaLista(d)}</Pantalla>, eligiendo <Pantalla>{d.letraNueva}</Pantalla>.
              </li>
            ))}
            <li>
              Vuelve aquí y pulsa <Pantalla>Ya está, comprobar</Pantalla>. Pensadero buscará {varios ? 'los discos' : 'el disco'} en
              su letra nueva y te ofrecerá «Usar esa ubicación» en cada biblioteca.
            </li>
          </ol>
          <p className="mt-2 text-[11px] text-humo">
            Si esa letra no sale en el desplegable es que ya la usa otra cosa: elige otra del final del abecedario. Las
            letras del final no se las da Windows a un pendrive al conectarlo, así que no vuelven a cruzarse.
          </p>
          <button
            onClick={onComprobar}
            disabled={comprobando}
            className="mt-2.5 px-3 py-1 rounded-full text-xs font-medium bg-lavanda text-noche hover:bg-lavanda-claro disabled:opacity-50 transition-colors"
          >
            {comprobando ? 'Comprobando…' : 'Ya está, comprobar'}
          </button>
        </div>
      )}
    </div>
  );
}
