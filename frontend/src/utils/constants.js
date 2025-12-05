import { TopologyIcon, SwitchIcon, WifiIcon, ServerIcon } from '../components/dashboard/DashboardIcons';

/**
 * Secciones por defecto del dashboard
 */
export const DEFAULT_SECTIONS = [
  { k: 'topology', t: 'Topología', IconComponent: TopologyIcon },
  { k: 'switches', t: 'Switches', IconComponent: SwitchIcon },
  { k: 'access_points', t: 'Puntos de acceso', IconComponent: WifiIcon },
  { k: 'appliance_status', t: 'Estado (appliances)', IconComponent: ServerIcon }
];

/**
 * Configuración por defecto para uplinks
 */
export const DEFAULT_UPLINK_TIMESPAN = 24 * 3600; // 24h
export const DEFAULT_UPLINK_RESOLUTION = 300; // 5 min buckets

/**
 * Headers para evitar caching en peticiones de API
 * Crítico para evitar problemas de datos obsoletos en producción
 */
export const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0'
};

/**
 * Detecta si la página fue recargada (F5/refresh)
 * Usa PerformanceNavigationTiming API moderna en lugar de la deprecada
 * @returns {boolean}
 */
export const isPageReload = () => {
  if (typeof window === 'undefined') return false;
  
  // API moderna (recomendada)
  if (window.performance?.getEntriesByType) {
    const navEntries = window.performance.getEntriesByType('navigation');
    if (navEntries.length > 0) {
      return navEntries[0].type === 'reload';
    }
  }
  
  // Fallback para navegadores legacy
  if (window.performance?.navigation) {
    return window.performance.navigation.type === 1;
  }
  
  return false;
};
