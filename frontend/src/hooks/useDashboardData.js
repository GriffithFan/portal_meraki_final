import { useState, useCallback, useRef, useEffect } from 'react';
import { DEFAULT_UPLINK_TIMESPAN, DEFAULT_UPLINK_RESOLUTION } from '../utils/constants';

/**
 * Hook personalizado para manejar la carga de datos del dashboard
 * 
 * Centraliza toda la lógica de carga de datos, caching y estado
 * para simplificar el componente Dashboard.jsx
 * 
 * @param {Object} options - Opciones de configuración
 * @param {Object} options.initialNetwork - Red seleccionada inicialmente
 * @returns {Object} Estado y métodos para manejar datos del dashboard
 */
export const useDashboardData = ({ initialNetwork = null } = {}) => {
  const [selectedNetwork, setSelectedNetwork] = useState(initialNetwork);
  const [summaryData, setSummaryData] = useState(null);
  const [loadedSections, setLoadedSections] = useState(new Set());
  const [sectionLoading, setSectionLoading] = useState(null);
  const [loading, setLoading] = useState(false);
  const [uplinkRange, setUplinkRange] = useState(DEFAULT_UPLINK_TIMESPAN);
  const [error, setError] = useState('');
  const [enrichedAPs, setEnrichedAPs] = useState(null);
  const [apDataSource, setApDataSource] = useState(null);
  const [loadingLLDP, setLoadingLLDP] = useState(false);
  const [apConnectivityData, setApConnectivityData] = useState({});
  
  // Refs para evitar fetches duplicados
  const abortControllerRef = useRef(null);
  const hasFetchedEnrichedApsRef = useRef(false);

  /**
   * Construye URL para obtener resumen de red
   */
  const buildSummaryUrl = useCallback((networkId, { timespan, resolution, quick = true } = {}) => {
    const params = new URLSearchParams();
    const ts = timespan ?? uplinkRange ?? DEFAULT_UPLINK_TIMESPAN;
    const res = resolution ?? DEFAULT_UPLINK_RESOLUTION;
    if (ts) params.set('uplinkTimespan', ts);
    if (res) params.set('uplinkResolution', res);
    if (quick) params.set('quick', 'true');
    return `/api/networks/${networkId}/summary${params.toString() ? `?${params}` : ''}`;
  }, [uplinkRange]);

  /**
   * Carga el resumen inicial de una red
   */
  const loadSummary = useCallback(async (networkId) => {
    if (!networkId) return;
    
    setLoading(true);
    setError('');
    setSummaryData(null);
    setLoadedSections(new Set());
    
    try {
      const url = buildSummaryUrl(networkId);
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`Error ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      setSummaryData(data);
      
      // Marcar secciones que vienen precargadas
      const preloadedSections = new Set();
      if (data.topology) preloadedSections.add('topology');
      if (data.applianceStatus) preloadedSections.add('appliance_status');
      setLoadedSections(preloadedSections);
      
    } catch (err) {
      console.error('Error cargando resumen:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [buildSummaryUrl]);

  /**
   * Carga una sección específica bajo demanda
   */
  const loadSection = useCallback(async (sectionKey, { force = false } = {}) => {
    if (!selectedNetwork?.id) return;
    
    if (loadedSections.has(sectionKey)) {
      return;
    }
    
    setSectionLoading(sectionKey);
    console.debug(`Cargando sección '${sectionKey}'...`);
    
    try {
      const params = new URLSearchParams();
      if (sectionKey === 'appliance_status') {
        params.set('uplinkTimespan', uplinkRange || DEFAULT_UPLINK_TIMESPAN);
        params.set('uplinkResolution', DEFAULT_UPLINK_RESOLUTION);
      }
      
      const url = `/api/networks/${selectedNetwork.id}/section/${sectionKey}${params.toString() ? `?${params}` : ''}`;
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`Error cargando sección ${sectionKey}`);
      }
      
      const sectionData = await response.json();
      
      // Merge con summaryData existente
      setSummaryData(prev => {
        const merged = { ...prev };
        
        switch (sectionKey) {
          case 'topology':
            merged.topology = sectionData.topology;
            if (sectionData.devices && !prev?.devices) merged.devices = sectionData.devices;
            break;
          case 'switches':
            merged.switchesDetailed = sectionData.switchesDetailed;
            merged.switchesOverview = sectionData.switchesOverview;
            break;
          case 'access_points':
            merged.accessPoints = sectionData.accessPoints;
            break;
          case 'appliance_status':
            merged.applianceStatus = sectionData.applianceStatus;
            if (sectionData.topology) merged.topology = sectionData.topology;
            break;
        }
        
        return merged;
      });
      
      setLoadedSections(prev => new Set(prev).add(sectionKey));
      
    } catch (error) {
      console.error(`Error cargando '${sectionKey}':`, error);
      setError(`Error cargando ${sectionKey}: ${error.message}`);
    } finally {
      setSectionLoading(null);
    }
  }, [selectedNetwork, loadedSections, uplinkRange]);

  /**
   * Carga datos enriquecidos de Access Points
   */
  const loadEnrichedAPs = useCallback(async (networkId) => {
    if (!networkId || hasFetchedEnrichedApsRef.current) return;
    
    hasFetchedEnrichedApsRef.current = true;
    setLoadingLLDP(true);
    
    try {
      const url = `/api/networks/${networkId}/access-points/enriched`;
      const response = await fetch(url);
      
      if (response.ok) {
        const data = await response.json();
        if (data && Array.isArray(data.accessPoints)) {
          setEnrichedAPs(data.accessPoints);
          setApDataSource('lldp');
          return data.accessPoints;
        }
      }
    } catch (err) {
      console.error('Error cargando datos LLDP de APs:', err);
    } finally {
      setLoadingLLDP(false);
    }
    return null;
  }, []);

  /**
   * Resetea el estado de datos
   */
  const resetData = useCallback(() => {
    setSummaryData(null);
    setLoadedSections(new Set());
    setEnrichedAPs(null);
    setApDataSource(null);
    setLoadingLLDP(false);
    setApConnectivityData({});
    hasFetchedEnrichedApsRef.current = false;
    setError('');
  }, []);

  /**
   * Actualiza datos de conectividad para un AP específico
   */
  const updateApConnectivity = useCallback((serial, data) => {
    setApConnectivityData(prev => ({
      ...prev,
      [serial]: data
    }));
  }, []);

  /**
   * Verifica si una sección está cargada
   */
  const isSectionLoaded = useCallback((sectionKey) => {
    return loadedSections.has(sectionKey);
  }, [loadedSections]);

  /**
   * Obtiene los datos de una sección específica
   */
  const getSectionData = useCallback((sectionKey) => {
    if (!summaryData) return null;
    
    switch (sectionKey) {
      case 'topology':
        return summaryData.topology;
      case 'switches':
        return {
          detailed: summaryData.switchesDetailed,
          overview: summaryData.switchesOverview
        };
      case 'access_points':
        return enrichedAPs || summaryData.accessPoints;
      case 'appliance_status':
        return summaryData.applianceStatus;
      default:
        return summaryData[sectionKey];
    }
  }, [summaryData, enrichedAPs]);

  // Cleanup al desmontar o cambiar de red
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Reset cuando cambia la red
  useEffect(() => {
    if (selectedNetwork?.id) {
      resetData();
    }
  }, [selectedNetwork?.id, resetData]);

  return {
    // Estado
    selectedNetwork,
    summaryData,
    loadedSections,
    sectionLoading,
    loading,
    uplinkRange,
    error,
    enrichedAPs,
    apDataSource,
    loadingLLDP,
    apConnectivityData,
    
    // Setters
    setSelectedNetwork,
    setSummaryData,
    setUplinkRange,
    setError,
    setEnrichedAPs,
    setApDataSource,
    
    // Métodos
    loadSummary,
    loadSection,
    loadEnrichedAPs,
    resetData,
    updateApConnectivity,
    
    // Helpers
    isSectionLoaded,
    getSectionData,
    buildSummaryUrl,
    
    // Constantes
    DEFAULT_UPLINK_TIMESPAN,
    DEFAULT_UPLINK_RESOLUTION
  };
};
