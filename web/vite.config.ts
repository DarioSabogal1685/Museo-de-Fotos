import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string }

/** Publica version.json junto a la web para que la app pueda comprobar si hay una version nueva. */
function versionFile(): Plugin {
  const content = JSON.stringify({ version: pkg.version })
  return {
    name: 'version-file',
    configureServer(server) {
      server.middlewares.use('/version.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(content)
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: content })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react(), versionFile()],
  // En GitHub Pages la web vive en /Museo-de-Fotos/; en desarrollo, en la raiz.
  base: command === 'build' ? '/Museo-de-Fotos/' : '/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
}))
