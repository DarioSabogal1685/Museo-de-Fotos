import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string }

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // En GitHub Pages la web vive en /Museo-de-Fotos/; en desarrollo, en la raiz.
  base: command === 'build' ? '/Museo-de-Fotos/' : '/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
}))
