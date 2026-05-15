import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['lucide-react'],
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
