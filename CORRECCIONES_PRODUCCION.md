# Correcciones de Producción - VPS

## Resumen de Problemas Detectados y Soluciones

Este documento describe los problemas identificados que causaban comportamiento errático en producción y las soluciones implementadas.

---

## 🚨 Problema 1: PWA con Caching Agresivo

### Síntomas
- Datos obsoletos mostrados incluso después de actualizar
- Componentes mostrando información incorrecta
- Cambios en el backend no reflejados en el frontend

### Causa Raíz
La configuración del PWA en `vite.config.js` estaba cacheando agresivamente:
- APIs del backend (`/api/...`)
- El archivo `index.html`
- Archivos `manifest.json` y service workers

Además, `skipWaiting: true` + `clientsClaim: true` causaba que el nuevo service worker tomara control inmediato con cache viejo.

### Solución Implementada
```javascript
// vite.config.js - ANTES
workbox: {
  globPatterns: ['**/*.{js,css,html,ico,png,svg,json}'],
  skipWaiting: true,
  clientsClaim: true,
  runtimeCaching: [
    // Cacheaba APIs del backend ❌
    { urlPattern: /^https:\/\/portalmeraki\.info\/api\/.*/i, ... }
  ]
}

// vite.config.js - DESPUÉS
workbox: {
  // Solo assets estáticos, NO html ni APIs
  globPatterns: ['**/*.{js,css,ico,png,svg,woff,woff2}'],
  globIgnores: ['**/index.html', '**/manifest.json', '**/sw.js'],
  skipWaiting: false,  // No forzar activación inmediata
  clientsClaim: false,
  runtimeCaching: [
    // Solo API externa de Meraki, NO el backend
    { urlPattern: /^https:\/\/api\.meraki\.com\/.*/i, handler: 'NetworkOnly' }
  ],
  navigateFallbackDenylist: [/^\/api\//]
}
```

---

## 🚨 Problema 2: API de Navegación Deprecada

### Síntomas
- Comportamiento inconsistente en detección de page reload
- Red seleccionada previamente no se cargaba correctamente al recargar

### Causa Raíz
Uso de `window.performance.navigation` que está **deprecada** y puede no funcionar en navegadores modernos.

### Solución Implementada
```javascript
// ANTES (deprecado)
const isPageReload = window.performance?.navigation?.type === 1;

// DESPUÉS (API moderna con fallback)
export const isPageReload = () => {
  if (window.performance?.getEntriesByType) {
    const navEntries = window.performance.getEntriesByType('navigation');
    if (navEntries.length > 0) {
      return navEntries[0].type === 'reload';
    }
  }
  // Fallback para navegadores legacy
  return window.performance?.navigation?.type === 1;
};
```

---

## 🚨 Problema 3: Falta de Cache-Busting en Peticiones API

### Síntomas
- Datos viejos servidos desde cache del navegador
- Problemas de sincronización entre lo que muestra el frontend y los datos reales

### Solución Implementada
Creado `src/utils/api.js` con funciones que agregan headers anti-cache:

```javascript
export async function fetchAPI(url, options = {}) {
  const headers = {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    ...options.headers
  };

  // Cache-busting con timestamp
  const cacheBustUrl = `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`;

  return fetch(cacheBustUrl, {
    ...options,
    headers,
    cache: 'no-store'  // Forzar no usar cache del navegador
  });
}
```

---

## 🛠️ Herramienta de Limpieza de Caché

Se creó `/clear-cache.html` que permite:
- Limpiar localStorage y sessionStorage
- Eliminar todos los Cache Storage del PWA
- Desregistrar Service Workers
- Limpiar IndexedDB

**Acceso:** `https://portalmeraki.info/clear-cache.html`

---

## 📋 Pasos para Desplegar en Producción

### 1. Actualizar el código
```bash
cd /root/portal-meraki-deploy
git pull origin main
```

### 2. Reconstruir el frontend
```bash
cd frontend
npm run build
```

### 3. Reiniciar el backend
```bash
cd ../backend
pm2 restart portal-meraki
```

### 4. Limpiar cache de usuarios existentes
Los usuarios deben visitar `/clear-cache.html` una vez para limpiar caches antiguos.

Alternativamente, pueden:
1. Abrir DevTools (F12)
2. Ir a Application > Storage
3. Click en "Clear site data"
4. Recargar la página

---

## 🔍 Verificación Post-Despliegue

1. **Verificar que no hay service workers viejos:**
   - DevTools > Application > Service Workers
   - Debería mostrar solo un SW con estado "activated"

2. **Verificar headers anti-cache en APIs:**
   - DevTools > Network > Filtrar por XHR
   - Los requests a `/api/...` deben tener `?_t=timestamp`

3. **Verificar build correcto:**
   - Los assets JS/CSS deben tener hashes en el nombre
   - Ejemplo: `index-a1b2c3d4.js`

---

## 📝 Archivos Modificados

| Archivo | Cambios |
|---------|---------|
| `frontend/vite.config.js` | Reducido caching de PWA |
| `frontend/src/utils/api.js` | **NUEVO** - Funciones fetch con anti-cache |
| `frontend/src/utils/constants.js` | Agregado `isPageReload()` y `NO_CACHE_HEADERS` |
| `frontend/src/pages/Dashboard.jsx` | Usa `fetchAPI` y nueva función `isPageReload` |
| `frontend/public/clear-cache.html` | **NUEVO** - Herramienta de limpieza |

---

## 🎯 Resultado Esperado

Después de aplicar estas correcciones:
- ✅ Los datos siempre se obtienen frescos del servidor
- ✅ No hay inconsistencias entre lo que muestra el frontend y el backend
- ✅ Los page reloads funcionan correctamente
- ✅ Los usuarios pueden forzar limpieza de cache si hay problemas residuales
