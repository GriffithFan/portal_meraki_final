/**
 * API utilities para el frontend
 * 
 * Centraliza las peticiones fetch con headers anti-cache
 * para evitar problemas de datos obsoletos en producción
 */

import { NO_CACHE_HEADERS } from './constants';

/**
 * Fetch con headers anti-cache para APIs
 * Garantiza datos frescos en cada petición
 * 
 * @param {string} url - URL a consultar
 * @param {Object} options - Opciones de fetch
 * @returns {Promise<Response>}
 */
export async function fetchAPI(url, options = {}) {
  const headers = {
    ...NO_CACHE_HEADERS,
    ...options.headers
  };

  // Agregar timestamp para cache-busting adicional en URLs
  const separator = url.includes('?') ? '&' : '?';
  const cacheBustUrl = `${url}${separator}_t=${Date.now()}`;

  return fetch(cacheBustUrl, {
    ...options,
    headers,
    // Forzar no usar cache del navegador
    cache: 'no-store'
  });
}

/**
 * Fetch JSON con anti-cache
 * 
 * @param {string} url - URL a consultar
 * @param {Object} options - Opciones de fetch
 * @returns {Promise<Object>} - Datos JSON parseados
 * @throws {Error} - Si la respuesta no es ok o no es JSON válido
 */
export async function fetchJSON(url, options = {}) {
  const response = await fetchAPI(url, {
    ...options,
    headers: {
      'Accept': 'application/json',
      ...options.headers
    }
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Error desconocido');
    throw new Error(`Error ${response.status}: ${errorText}`);
  }

  return response.json();
}

/**
 * POST JSON con anti-cache
 * 
 * @param {string} url - URL a consultar
 * @param {Object} data - Datos a enviar
 * @param {Object} options - Opciones adicionales de fetch
 * @returns {Promise<Object>} - Respuesta JSON
 */
export async function postJSON(url, data, options = {}) {
  return fetchJSON(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    body: JSON.stringify(data),
    ...options
  });
}

/**
 * Limpia todos los caches del Service Worker
 * Útil cuando se detectan problemas de datos obsoletos
 * 
 * @returns {Promise<boolean>} - true si se limpiaron caches
 */
export async function clearServiceWorkerCaches() {
  if (!('caches' in window)) {
    console.warn('Cache API no disponible');
    return false;
  }

  try {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames.map(cacheName => {
        console.log(`Eliminando cache: ${cacheName}`);
        return caches.delete(cacheName);
      })
    );
    
    // También desregistrar service workers
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(
        registrations.map(reg => {
          console.log('Desregistrando service worker');
          return reg.unregister();
        })
      );
    }
    
    console.log('Caches y service workers limpiados exitosamente');
    return true;
  } catch (error) {
    console.error('Error limpiando caches:', error);
    return false;
  }
}

/**
 * Fuerza actualización del service worker y recarga la página
 */
export async function forceRefresh() {
  await clearServiceWorkerCaches();
  window.location.reload(true);
}

export default {
  fetchAPI,
  fetchJSON,
  postJSON,
  clearServiceWorkerCaches,
  forceRefresh
};
