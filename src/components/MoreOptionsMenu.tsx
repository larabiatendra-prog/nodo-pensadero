import React, { useState, useRef, useEffect } from 'react';
import {
  MoreVertical,
  Home,
  Tag,
  BarChart3,
  FolderSync,
  FolderOpen,
  Users,
  MapPin,
  Languages,
  Copy,
  Lock,
  Trash2,
  Sparkles,
  X
} from 'lucide-react';

// Single-user: todas las opciones disponibles para el único usuario.
// Sin "Administración" (no hay panel de admin en uso personal).
// La busqueda por imagen ya no esta aqui: ahora se hace arrastrando la
// imagen sobre la vista home (drag & drop).
//
// Menu global reutilizable. Dos presentaciones del disparador (`variant`) y dos
// direcciones de apertura del desplegable (`placement`). UNA sola fuente de
// items: el header global murio y ahora el unico disparador es la burbuja
// flotante (variant='bubble', placement='top'), pero conservamos el boton de
// tres puntos (variant='icon') por compatibilidad y para no duplicar el menu.
interface MoreOptionsMenuProps {
  activeView: string;
  onViewChange: (view: string) => void;
  // 'top' abre hacia arriba (desde la burbuja inferior-derecha); 'bottom' hacia abajo.
  placement?: 'top' | 'bottom';
  // 'bubble' = burbuja redonda con el logo Pensadero; 'icon' = boton de tres puntos.
  variant?: 'bubble' | 'icon';
}

export function MoreOptionsMenu({ activeView, onViewChange, placement = 'bottom', variant = 'icon' }: MoreOptionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Disparador (burbuja o tres puntos): se le devuelve el foco al cerrar para
  // mantener la continuidad de teclado (patron menu-button de WAI-ARIA).
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Items del menu. 'home' es el primero: hereda la accion que antes tenia el
  // logo del header (volver a la galeria + limpiar favoritos/coleccion). Esa
  // limpieza la hace el onViewChange del call-site, igual que para el resto.
  const menuItems = [
    { id: 'home',        icon: Home,       label: 'Inicio',               description: 'Volver a la galería principal' },
    { id: 'portada',     icon: Sparkles,   label: 'Portada',              description: 'Los recuerdos flotando y lo que los une' },
    { id: 'collections', icon: FolderOpen, label: 'Colecciones',          description: 'Colecciones manuales y Smart Folders con reglas' },
    { id: 'tags',        icon: Tag,        label: 'Gestión de Etiquetas', description: 'Administrar etiquetas del sistema' },
    { id: 'synonyms',    icon: Languages,  label: 'Sinónimos',            description: 'Agrupar palabras parecidas para la búsqueda' },
    { id: 'persons',     icon: Users,      label: 'Personas',             description: 'Registrar caras y entrenar identidades' },
    { id: 'spaces',      icon: MapPin,     label: 'Espacios',             description: 'Lugares físicos identificables con CLIP' },
    { id: 'duplicates',  icon: Copy,       label: 'Tomas gemelas',        description: 'Material casi idéntico agrupado para quedarte con una' },
    { id: 'statistics',  icon: BarChart3,  label: 'Estadísticas',         description: 'Ver métricas y análisis' },
    { id: 'paths',       icon: FolderSync, label: 'Administrar Rutas',    description: 'Configurar directorios escaneados' },
    { id: 'ocultos',     icon: Lock,       label: 'Material oculto',      description: 'Lo que está bajo candado. Pide la clave' },
    { id: 'papelera',    icon: Trash2,     label: 'Papelera',             description: 'Lo que has sacado del archivo. Se puede restaurar' },
  ];

  // Cerrar menú al hacer clic fuera
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Cerrar menú con Escape. Se registra en WINDOW en fase de captura: window
  // precede a document en el path del evento, asi que este handler corre ANTES
  // que los listeners globales de App (colapsar sesion / limpiar filtros), que
  // estan en document. stopImmediatePropagation impide que el mismo Esc los
  // dispare: con el menu abierto, el primer Esc SOLO cierra el menu. Asi no
  // dependemos del orden de montaje/remontaje del componente.
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      e.preventDefault();
      setIsOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener('keydown', handleEscape, true);
    return () => window.removeEventListener('keydown', handleEscape, true);
  }, [isOpen]);

  const handleItemClick = (viewId: string) => {
    onViewChange(viewId);
    setIsOpen(false);
    // Devolver el foco al disparador (continuidad de teclado tras navegar).
    triggerRef.current?.focus();
  };

  // Posicion del desplegable segun direccion de apertura.
  const dropdownPos = placement === 'top'
    ? 'bottom-full right-0 mb-3 origin-bottom-right'
    : 'top-full right-0 mt-2 origin-top-right';

  return (
    <div className="relative" ref={menuRef}>
      {/* Disparador */}
      {variant === 'bubble' ? (
        // Burbuja flotante permanente: punto unico de navegacion global.
        <button
          ref={triggerRef}
          onClick={() => setIsOpen(!isOpen)}
          className={`
            flex items-center justify-center rounded-full
            transition-all duration-200 shadow-2xl ring-1 backdrop-blur
            ${isOpen
              ? 'ring-lavanda bg-grafito scale-105'
              : 'ring-borde-sutil bg-tinta/90 hover:ring-lavanda hover:bg-grafito hover:scale-105'
            }
          `}
          title="Menú Pensadero"
          aria-label="Abrir menú de navegación"
          aria-haspopup="true"
          aria-expanded={isOpen}
        >
          <img src="/pensadero-logo.png" alt="Pensadero" className="h-24 w-24 rounded-full p-3" />
        </button>
      ) : (
        <button
          ref={triggerRef}
          onClick={() => setIsOpen(!isOpen)}
          className={`
            p-2 rounded-full transition-all duration-200
            ${isOpen
              ? 'bg-lavanda text-white shadow-lg'
              : 'text-lavanda-archivo hover:bg-pizarra'
            }
          `}
          title="Más opciones"
          aria-label="Abrir menú de opciones"
          aria-haspopup="true"
          aria-expanded={isOpen}
        >
          <MoreVertical className="w-4 h-4" />
        </button>
      )}

      {/* Dropdown menu */}
      {isOpen && (
        <div className={`absolute ${dropdownPos} w-64 sm:w-72 z-50`}>
          {/* Backdrop para blur en móvil */}
          <div className="fixed inset-0 z-40 sm:hidden" onClick={() => setIsOpen(false)} />

          {/* Menú. max-height + scroll: abriendo hacia arriba (placement='top')
              desde la burbuja inferior, en portatiles de poca altura el menu
              (9 items) se saldria por arriba dejando los primeros inaccesibles. */}
          <div className="relative z-50 bg-tinta rounded-xl shadow-2xl border border-pizarra overflow-y-auto max-h-[calc(100vh-7rem)]">
            {/* Header */}
            <div className="px-4 py-3 bg-gradient-to-r from-lavanda/10 to-lavanda-claro/10 border-b border-pizarra">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-marfil">Opciones</h3>
                <button
                  onClick={() => setIsOpen(false)}
                  className="p-1 hover:bg-lavanda-archivo/10 rounded-lg transition-colors"
                  aria-label="Cerrar menú"
                >
                  <X className="w-3.5 h-3.5 text-lavanda-archivo" />
                </button>
              </div>
            </div>

            {/* Menu items */}
            <div className="py-2">
              {menuItems.map((item, index) => {
                const Icon = item.icon;
                const isActive = activeView === item.id;

                return (
                  <React.Fragment key={item.id}>
                    {/* Separador tras "Inicio" para destacarlo del resto */}
                    {item.id === 'collections' && (
                      <div className="mx-3 my-2 border-t border-pizarra" />
                    )}
                    {/* Separador antes de "Administrar Rutas" */}
                    {item.id === 'paths' && index > 0 && (
                      <div className="mx-3 my-2 border-t border-pizarra" />
                    )}

                    <button
                      onClick={() => handleItemClick(item.id)}
                      className={`
                        w-full px-4 py-3 flex items-start gap-3
                        transition-all duration-200 group
                        ${isActive
                          ? 'bg-lavanda/10 text-lavanda'
                          : 'hover:bg-grafito text-marfil hover:text-lavanda'
                        }
                      `}
                    >
                      <div className={`
                        p-2 rounded-lg transition-all duration-200
                        ${isActive
                          ? 'bg-lavanda text-white'
                          : 'bg-pizarra group-hover:bg-lavanda/20'
                        }
                      `}>
                        <Icon className="w-4 h-4" />
                      </div>
                      <div className="flex-1 text-left">
                        <p className="font-medium text-sm">
                          {item.label}
                        </p>
                        <p className={`
                          text-xs mt-0.5
                          ${isActive ? 'text-lavanda/70' : 'text-lavanda-archivo'}
                        `}>
                          {item.description}
                        </p>
                      </div>
                      {isActive && (
                        <div className="w-1 h-8 bg-lavanda rounded-full self-center" />
                      )}
                    </button>
                  </React.Fragment>
                );
                })}
            </div>

            {/* Footer hint */}
            <div className="px-4 py-2 bg-pizarra/30 border-t border-pizarra">
              <p className="text-xs text-lavanda-archivo text-center">
                {menuItems.length} {menuItems.length === 1 ? 'opción' : 'opciones'} disponibles
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
