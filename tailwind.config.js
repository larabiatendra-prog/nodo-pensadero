/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // ============================================
        // Pensadero — paleta noche/lavanda
        // Tokens semánticos en español
        // ============================================

        // Fondos
        noche: '#0F111A',          // Fondo principal — Noche profunda
        tinta: '#151927',          // Fondo secundario — Azul tinta
        grafito: '#1C2033',        // Superficie — Grafito violeta
        pizarra: '#252A42',        // Superficie elevada — Pizarra lavanda

        // Acentos
        lavanda: '#C8B6FF',        // Acento principal — Lavanda memoria
        'lavanda-claro': '#DACDFF', // Acento hover
        'lavanda-archivo': '#7C6BB2', // Acento oscuro — para bordes/disabled

        // Complementarios
        melocoton: '#F2B8A0',       // Cálido
        salvia: '#9CB7A5',          // Verde
        bruma: '#8EA4FF',           // Azul — usar para LINKS

        // Texto
        marfil: '#F5F1FF',          // Texto principal
        niebla: '#B8B3C9',          // Texto secundario
        humo: '#7D8197',            // Texto terciario (metadatos)

        // Estados
        'estado-exito': '#A8D5BA',
        'estado-aviso': '#E6C177',
        'estado-error': '#E58B9B',

        // Borde sutil (alpha del grafito)
        'borde-sutil': 'rgba(37, 42, 66, 0.6)',

        // ============================================
        // Compatibilidad con tokens antiguos
        // (mapeados al nuevo sistema noche/lavanda)
        // ============================================
        'jaffa': '#C8B6FF',        // → lavanda
        'apricot': '#DACDFF',      // → lavanda-claro
        'romantic': '#F2B8A0',     // → melocoton
        'st-tropaz': '#8EA4FF',    // → bruma
        'russett': '#7C6BB2',      // → lavanda-archivo
        'spring-wood': '#1C2033',  // → grafito (era card bg claro)
        'tundora': '#F5F1FF',      // → marfil (era texto principal)
        'ebb': '#252A42',          // → pizarra (era borde claro)
        'wild-sand': '#0F111A',    // → noche (era fondo principal)

        // Roles semánticos antiguos
        'primary': '#C8B6FF',
        'primary-soft': '#DACDFF',
        'secondary': '#8EA4FF',
        'text-primary': '#F5F1FF',
        'text-secondary': '#B8B3C9',
        'bg-primary': '#0F111A',
        'bg-secondary': '#151927',
        'bg-tertiary': '#1C2033',
        'border': 'rgba(37, 42, 66, 0.6)',
      },
      fontFamily: {
        sans: ['Geist', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'monospace'],
        // Compatibilidad
        geist: ['Geist', 'Inter', 'system-ui', 'sans-serif'],
        telegraf: ['Geist', 'Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'fadeIn': 'fadeIn 0.2s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(-4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
  corePlugins: {
    // line-clamp incluido por defecto en Tailwind 3.3+
  }
};
