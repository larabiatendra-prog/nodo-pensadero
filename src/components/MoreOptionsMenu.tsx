import React, { useState, useRef, useEffect } from 'react';
import {
  MoreVertical,
  Tag,
  BarChart3,
  FolderSync,
  Users,
  Languages,
  X
} from 'lucide-react';

// Single-user: todas las opciones disponibles para el único usuario.
// Sin "Administración" (no hay panel de admin en uso personal).
interface MoreOptionsMenuProps {
  activeView: string;
  onViewChange: (view: string) => void;
}

export function MoreOptionsMenu({ activeView, onViewChange }: MoreOptionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // "Buscar por Imagen" está desactivado: depende de un índice vectorial
  // (ChromaDB / embeddings) que no se distribuye en Pensadero personal.
  // Reactivar requiere reintroducir el pipeline vectorial.
  const menuItems = [
    { id: 'tags',        icon: Tag,        label: 'Gestión de Etiquetas', description: 'Administrar etiquetas del sistema' },
    { id: 'synonyms',    icon: Languages,  label: 'Sinónimos',            description: 'Agrupar palabras parecidas para la búsqueda' },
    { id: 'persons',     icon: Users,      label: 'Personas',             description: 'Registrar caras y entrenar identidades' },
    { id: 'statistics',  icon: BarChart3,  label: 'Estadísticas',         description: 'Ver métricas y análisis' },
    { id: 'paths',       icon: FolderSync, label: 'Administrar Rutas',    description: 'Configurar directorios escaneados' },
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

  // Cerrar menú con Escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  // Siempre mostrar el botón pero con contenido diferente según rol
  // Si el usuario no tiene permisos, mostrar un mensaje

  const handleItemClick = (viewId: string) => {
    onViewChange(viewId);
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={menuRef}>
      {/* Botón del menú */}
      <button
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
        aria-expanded={isOpen}
      >
        <MoreVertical className="w-4 h-4" />
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div className="absolute top-full right-0 mt-2 w-64 sm:w-72 origin-top-right z-50">
          {/* Backdrop para blur en móvil */}
          <div className="fixed inset-0 z-40 sm:hidden" onClick={() => setIsOpen(false)} />

          {/* Menú */}
          <div className="relative z-50 bg-tinta rounded-xl shadow-2xl border border-pizarra overflow-hidden">
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