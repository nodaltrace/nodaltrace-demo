import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        // Bibliotecas em chunks próprios: mudam pouco, então um deploy do app não invalida o cache delas no navegador.
        codeSplitting: {
          groups: [
            { name: 'maplibre', test: /node_modules[\\/](maplibre-gl|@maplibre|react-map-gl|@vis\.gl)[\\/]/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    // API e tiles rodam no docker compose; o navegador fala só com o Vite.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', rewrite: (p) => p.replace(/^\/api/, '') },
      '/tiles': { target: 'http://127.0.0.1:3000', rewrite: (p) => p.replace(/^\/tiles/, '') },
    },
  },
})
