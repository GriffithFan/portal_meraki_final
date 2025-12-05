/**
 * LRU Cache Store
 * 
 * Implementación de cache con estrategia Least Recently Used (LRU)
 * y soporte para TTL (Time To Live).
 * 
 * @module cache/cacheStore
 */

/**
 * Clase LRUCache con límite de tamaño y TTL
 */
class LRUCache {
  /**
   * @param {Object} options - Opciones de configuración
   * @param {number} options.maxSize - Tamaño máximo del cache (default: 500)
   * @param {number} options.defaultTTL - TTL por defecto en ms (default: 5 min)
   * @param {string} options.name - Nombre del cache para logs
   */
  constructor({ maxSize = 500, defaultTTL = 5 * 60 * 1000, name = 'cache' } = {}) {
    this.maxSize = maxSize;
    this.defaultTTL = defaultTTL;
    this.name = name;
    this.cache = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      sets: 0
    };
  }

  /**
   * Obtiene un valor del cache
   * @param {string} key - Clave a buscar
   * @returns {*} Valor almacenado o undefined si no existe/expiró
   */
  get(key) {
    if (!key) return undefined;
    
    const entry = this.cache.get(key);
    
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }
    
    // Verificar TTL
    if (entry.exp < Date.now()) {
      this.cache.delete(key);
      this.stats.misses++;
      return undefined;
    }
    
    // Mover al final (más reciente) - LRU
    this.cache.delete(key);
    this.cache.set(key, entry);
    
    this.stats.hits++;
    return entry.data;
  }

  /**
   * Almacena un valor en el cache
   * @param {string} key - Clave
   * @param {*} data - Datos a almacenar
   * @param {number} [ttl] - TTL opcional en ms
   */
  set(key, data, ttl = this.defaultTTL) {
    if (!key) return;
    
    // Si ya existe, eliminarlo primero (para reordenar)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    
    // Evictar si excede el tamaño máximo
    while (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
      this.stats.evictions++;
    }
    
    this.cache.set(key, {
      data,
      exp: Date.now() + ttl,
      createdAt: Date.now()
    });
    
    this.stats.sets++;
  }

  /**
   * Elimina una entrada del cache
   * @param {string} key - Clave a eliminar
   * @returns {boolean} true si existía
   */
  delete(key) {
    return this.cache.delete(key);
  }

  /**
   * Verifica si existe una clave
   * @param {string} key - Clave a verificar
   * @returns {boolean}
   */
  has(key) {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (entry.exp < Date.now()) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Limpia todo el cache
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Obtiene el tamaño actual del cache
   * @returns {number}
   */
  get size() {
    return this.cache.size;
  }

  /**
   * Limpia entradas expiradas
   * @returns {number} Número de entradas eliminadas
   */
  prune() {
    const now = Date.now();
    let pruned = 0;
    
    for (const [key, entry] of this.cache) {
      if (entry.exp < now) {
        this.cache.delete(key);
        pruned++;
      }
    }
    
    return pruned;
  }

  /**
   * Obtiene estadísticas del cache
   * @returns {Object}
   */
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0
      ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
      : 0;
    
    return {
      ...this.stats,
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: `${hitRate}%`
    };
  }

  /**
   * Resetea estadísticas
   */
  resetStats() {
    this.stats = { hits: 0, misses: 0, evictions: 0, sets: 0 };
  }
}

// Configuración de TTLs por categoría
const TTL = {
  networks: 10 * 60 * 1000,        // 10 min
  devices: 3 * 60 * 1000,          // 3 min
  appliance: 1 * 60 * 1000,        // 1 min
  topology: 5 * 60 * 1000,         // 5 min
  lldp: Number(process.env.LLDP_CACHE_TTL_MS) || 10 * 60 * 1000, // 10 min default
  ports: 2 * 60 * 1000,            // 2 min
  wirelessEthernetStatuses: 15 * 60 * 1000,  // 15 min
  wirelessFailedConnections: 10 * 60 * 1000, // 10 min
  wirelessSignalQuality: 8 * 60 * 1000,      // 8 min
};

// Instancias de cache LRU
const cache = {
  networksByOrg: new LRUCache({ maxSize: 100, defaultTTL: TTL.networks, name: 'networksByOrg' }),
  networkById: new LRUCache({ maxSize: 500, defaultTTL: TTL.networks, name: 'networkById' }),
  devicesStatuses: new LRUCache({ maxSize: 200, defaultTTL: TTL.devices, name: 'devicesStatuses' }),
  applianceStatus: new LRUCache({ maxSize: 200, defaultTTL: TTL.appliance, name: 'applianceStatus' }),
  topology: new LRUCache({ maxSize: 200, defaultTTL: TTL.topology, name: 'topology' }),
  switchPorts: new LRUCache({ maxSize: 300, defaultTTL: TTL.ports, name: 'switchPorts' }),
  accessPoints: new LRUCache({ maxSize: 200, defaultTTL: TTL.devices, name: 'accessPoints' }),
  lldpByNetwork: new LRUCache({ maxSize: 200, defaultTTL: TTL.lldp, name: 'lldpByNetwork' }),
  wirelessEthernetStatuses: new LRUCache({ maxSize: 200, defaultTTL: TTL.wirelessEthernetStatuses, name: 'wirelessEthernetStatuses' }),
  wirelessFailedConnections: new LRUCache({ maxSize: 200, defaultTTL: TTL.wirelessFailedConnections, name: 'wirelessFailedConnections' }),
  wirelessSignalQuality: new LRUCache({ maxSize: 200, defaultTTL: TTL.wirelessSignalQuality, name: 'wirelessSignalQuality' }),
  TTL, // Exportar TTL para referencia
};

/**
 * Obtiene un valor del cache (compatibilidad con API anterior)
 * @param {LRUCache|Map} cacheInstance - Instancia de cache
 * @param {string} key - Clave
 * @param {string} [category] - Categoría (ignorado en LRUCache)
 * @returns {*} Valor o undefined
 */
function getFromCache(cacheInstance, key, category = 'networks') {
  if (!cacheInstance || !key) return undefined;
  
  // Soporte para LRUCache
  if (cacheInstance instanceof LRUCache) {
    return cacheInstance.get(key);
  }
  
  // Fallback para Map legacy
  const hit = cacheInstance.get(key);
  if (!hit) return undefined;
  const ttl = TTL[category] || TTL.networks;
  if (hit.exp < Date.now()) {
    cacheInstance.delete(key);
    return undefined;
  }
  return hit.data;
}

/**
 * Almacena un valor en el cache (compatibilidad con API anterior)
 * @param {LRUCache|Map} cacheInstance - Instancia de cache
 * @param {string} key - Clave
 * @param {*} data - Datos
 * @param {string} [category] - Categoría para TTL
 */
function setInCache(cacheInstance, key, data, category = 'networks') {
  if (!cacheInstance || !key) return;
  
  // Soporte para LRUCache
  if (cacheInstance instanceof LRUCache) {
    const ttl = TTL[category] || cacheInstance.defaultTTL;
    cacheInstance.set(key, data, ttl);
    return;
  }
  
  // Fallback para Map legacy
  const ttl = TTL[category] || TTL.networks;
  cacheInstance.set(key, { data, exp: Date.now() + ttl });
}

/**
 * Obtiene estadísticas de todos los caches
 * @returns {Object} Estadísticas por cache
 */
function getAllCacheStats() {
  const stats = {};
  for (const [name, cacheInstance] of Object.entries(cache)) {
    if (cacheInstance instanceof LRUCache) {
      stats[name] = cacheInstance.getStats();
    }
  }
  return stats;
}

/**
 * Limpia todos los caches
 */
function clearAllCaches() {
  for (const cacheInstance of Object.values(cache)) {
    if (cacheInstance instanceof LRUCache) {
      cacheInstance.clear();
    }
  }
}

/**
 * Elimina entradas expiradas de todos los caches
 * @returns {Object} Número de entradas eliminadas por cache
 */
function pruneAllCaches() {
  const results = {};
  for (const [name, cacheInstance] of Object.entries(cache)) {
    if (cacheInstance instanceof LRUCache) {
      results[name] = cacheInstance.prune();
    }
  }
  return results;
}

module.exports = {
  LRUCache,
  cache,
  getFromCache,
  setInCache,
  getAllCacheStats,
  clearAllCaches,
  pruneAllCaches,
  TTL,
};
