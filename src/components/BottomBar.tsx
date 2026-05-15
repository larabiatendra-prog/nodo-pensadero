// Barra inferior compacta — single-user, sin avatar ni rol.
// Muestra marca, contador de archivos y última sincronización.
interface BottomBarProps {
  totalFiles: number;
  lastSync?: Date | null;
}

// Formatea una fecha como "hace X min/h" en español.
function formatRelative(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.max(0, Math.floor(diffMs / 1000));
  if (diffSec < 60) return 'hace unos segundos';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `hace ${diffH} h`;
  const diffD = Math.floor(diffH / 24);
  return `hace ${diffD} d`;
}

export default function BottomBar({ totalFiles, lastSync }: BottomBarProps) {
  return (
    <footer
      className="h-10 bg-tinta border-t border-borde-sutil flex items-center justify-between px-4 font-mono text-xs text-humo"
      aria-label="Barra de estado"
    >
      <span className="font-sans font-medium">Pensadero</span>
      <span>{totalFiles.toLocaleString('es-ES')} archivos</span>
      <span>
        {lastSync ? `Sincronizado ${formatRelative(lastSync)}` : 'Sin sincronizar'}
      </span>
    </footer>
  );
}
