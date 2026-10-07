# Museo de Fotos

Galería de fotos en forma de casa: el usuario recorre un pasillo y entra a cada cuarto, y cada cuarto es una galería.

**Demo:** https://dariosabogal1685.github.io/Museo-de-Fotos/

## Cómo funciona

- **Casa:** plano visto desde arriba con un pasillo central. Te mueves con las flechas o WASD, o con clic, y entras a un cuarto empujando hacia su puerta, con Enter o con clic.
- **Cuartos:** cada cuarto es una subcarpeta de una carpeta de Google Drive. Las fotos de esa subcarpeta forman la galería.
- **Backend:** un Cloudflare Worker (`worker/`) lee y sube fotos a Drive con tu cuenta de Google, sin exponer claves en el navegador.
- **Web:** React + Vite (`web/`), publicada en GitHub Pages.

Sin backend configurado la web funciona en **modo demo**, con cuartos y fotos de ejemplo.

## Estructura

```
Museo-de-Fotos/
├── web/      # React + Vite (la casa y las galerías)
├── worker/   # Cloudflare Worker (API sobre Google Drive)
└── .github/workflows/deploy.yml   # publica web/ en GitHub Pages
```

## Ejecutar en local

Requiere Node.js 20 o superior.

```bash
cd web
npm install
npm run dev        # http://localhost:5173 (modo demo)
```

## Conectar Google Drive

1. Crea una carpeta en Drive para el museo. Sus subcarpetas serán los cuartos.
2. En Google Cloud, activa la **Drive API**, crea credenciales OAuth y obtén un refresh token con tu cuenta.
3. Copia `worker/.dev.vars.example` a `worker/.dev.vars` y rellena `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `DRIVE_FOLDER_ID` y `ADMIN_TOKEN` (una clave que inventes).
4. Arranca el Worker y la web:

```bash
cd worker && npm install && npm run dev     # http://localhost:8787
cd web && cp .env.example .env.local        # y activa VITE_API_URL
```

Para producción, despliega con `npm run deploy` en `worker/`, guarda los secretos con `wrangler secret put` y define la variable `VITE_API_URL` del repositorio con la URL del Worker.

## Autor

[DarioSabogal1685](https://github.com/DarioSabogal1685)
