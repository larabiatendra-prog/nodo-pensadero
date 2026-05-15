import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  build: {
    // Aviso de chunk grande movido de 500 KB a 700 KB; los chunks separados
    // por manualChunks ya están bien por debajo. Esto deja el aviso solo
    // para regresiones reales.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Code-splitting manual de las deps grandes. El primer load del
        // usuario carga sólo el chunk principal + react; el resto se trae
        // bajo demanda cuando se usa una vista que lo necesita.
        manualChunks: {
          // recharts + d3 son la deuda más gorda (~535 KB). Aislándolos,
          // sólo se cargan cuando el usuario abre Estadísticas. El resto del
          // tiempo el primer paint no los toca.
          'vendor-charts': ['recharts', 'd3'],
          'vendor-masonry': ['react-masonry-css'],
          'vendor-dnd': ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
          'vendor-toast': ['react-hot-toast'],
        },
      },
    },
  },
  server: {
    watch: {
      usePolling: true,
      interval: 500,
      ignored: [
        '**/backend/**',
        '**/thumbnails/**',
        '**/node_modules/**',
      ],
    },
  },
})
