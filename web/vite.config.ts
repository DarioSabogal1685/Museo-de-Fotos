import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // En GitHub Pages la web vive en /Museo-de-Fotos/; en desarrollo, en la raiz.
  base: command === 'build' ? '/Museo-de-Fotos/' : '/',
}))
