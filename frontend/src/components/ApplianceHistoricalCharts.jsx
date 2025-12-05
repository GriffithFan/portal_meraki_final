import React, { useState, useEffect, useRef } from 'react';

const ApplianceHistoricalCharts = ({ networkId }) => {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState({ connectivity: [], uplinkUsage: [] });
  const [timespan, setTimespan] = useState(86400); // 1 día por defecto
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [tooltip, setTooltip] = useState({ visible: false, x: 0, y: 0, content: '' });
  const svgRef = useRef(null);

  const timespanOptions = [
    { label: 'for the last 2 hours', value: 7200 },
    { label: 'for the last day', value: 86400 },
    { label: 'for the last week', value: 604800 },
    { label: 'for the last month', value: 2592000 }
  ];

  const getTimespanLabel = () => {
    const option = timespanOptions.find(opt => opt.value === timespan);
    return option ? option.label : 'for the last day';
  };

  useEffect(() => {
    if (!networkId) return;
    
    const fetchHistorical = async () => {
      setLoading(true);
      try {
        // Valores válidos de resolution según Meraki API: 60, 600, 3600, 86400
        const resolution = timespan <= 7200 ? 60 : timespan <= 86400 ? 600 : timespan <= 604800 ? 3600 : 86400;
        const response = await fetch(
          `/api/networks/${networkId}/appliance/historical?timespan=${timespan}&resolution=${resolution}`,
          { credentials: 'include' }
        );
        
        if (response.ok) {
          const result = await response.json();
          
          // Normalizar timestamps
          if (result.connectivity) {
            result.connectivity = result.connectivity.map(point => ({
              ...point,
              ts: point.ts || point.startTime || point.startTs || point.endTime
            }));
          }
          
          if (result.uplinkUsage) {
            result.uplinkUsage = result.uplinkUsage.map(point => ({
              ...point,
              ts: point.ts || point.startTime || point.endTime
            }));
          }
          
          setData(result);
        }
      } catch (error) {
        console.error('Error fetching appliance historical data:', error);
        setData({ connectivity: [], uplinkUsage: [] });
      } finally {
        setLoading(false);
      }
    };

    fetchHistorical();
  }, [networkId, timespan]);

  const formatTimestamp = (ts) => {
    if (!ts) {
      return '';
    }
    
    let date;
    if (typeof ts === 'string') {
      date = new Date(ts);
    } else if (typeof ts === 'number') {
      // Unix timestamp: si es mayor a 10 billones, ya está en ms
      date = ts > 10000000000 ? new Date(ts) : new Date(ts * 1000);
    } else {
      return '';
    }
    
    if (isNaN(date.getTime())) {
      return '';
    }
    
    // Para timespan corto (2 horas), mostrar hora:minuto
    if (timespan <= 7200) {
      return date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    }
    // Para día, mostrar hora:minuto
    if (timespan <= 86400) {
      return date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    }
    // Para semana o más, mostrar día/mes
    return date.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
  };

  const renderConnectivityChart = () => {
    
    if (!data.connectivity || data.connectivity.length === 0) {
      return (
        <div style={{ position: 'relative', marginTop: '4px' }}>
          <svg width="100%" height="8" style={{ display: 'block' }}>
            <rect x={0} y={0} width="100%" height="8" fill="#e5e7eb" rx="1" />
          </svg>
          <div style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            fontSize: '11px', 
            color: '#9ca3af', 
            marginTop: '6px',
            paddingLeft: '2px',
            paddingRight: '2px'
          }}>
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} style={{ textAlign: i === 0 ? 'left' : i === 5 ? 'right' : 'center' }}>--</span>
            ))}
          </div>
        </div>
      );
    }

    const points = data.connectivity;
    const chartHeight = 8;

    const pointsWithState = points.map(p => {
      const loss = p?.lossPercent != null ? Number(p.lossPercent) : (p?.loss != null ? Number(p.loss) : null);
      const latency = p?.latencyMs != null ? Number(p.latencyMs) : (p?.latency != null ? Number(p.latency) : null);

      let state = 'offline';
      
      const hasLatency = latency !== null && Number.isFinite(latency) && latency >= 0;
      const hasLoss = loss !== null && Number.isFinite(loss) && loss >= 0;
      
      // Si ambos son null, verificar el estado del uplink
      if (!hasLatency && !hasLoss) {
        // Distinguir entre offline total y failed connection
        if (p.uplinkStatus === 'offline') {
          state = 'offline'; // Gris - dispositivo completamente offline/no reportando
        } else if (p.uplinkStatus === 'failed') {
          state = 'no_signal'; // Rojo - dispositivo reporta pero sin conexión
        } else {
          state = 'offline'; // Gris por defecto - sin datos
        }
      } else {
        // Offline: latencia extrema (>10000ms) o pérdida casi total (>80%)
        const seemsOffline = (hasLatency && latency > 10000) || (hasLoss && loss > 80);
        
        if (seemsOffline) {
          state = 'offline'; // Gris
        } else {
          // Problemas: loss > 10% o latency > 200ms (más sensible)
          const poorConnection = (hasLoss && loss > 10) || (hasLatency && latency > 200);
          
          if (poorConnection) {
            state = 'no_signal'; // Rojo
          } else {
            state = 'connected'; // Verde
          }
        }
      }

      return { ...p, lossPercent: loss, latencyMs: latency, state };
    });

    const stateCount = pointsWithState.reduce((acc, p) => {
      acc[p.state] = (acc[p.state] || 0) + 1;
      return acc;
    }, {});

    const handleMouseMove = (e) => {
      if (!svgRef.current) return;
      
      const rect = svgRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const relativeX = x / rect.width;
      const pointIndex = Math.floor(relativeX * pointsWithState.length);
      const point = pointsWithState[pointIndex];
      
      if (point) {
        const timestamp = point.ts || point.startTs || point.timestamp || point.time;
        const date = timestamp ? new Date(timestamp) : null;
        const timeStr = date ? date.toLocaleString('es-ES', { 
          month: 'short', 
          day: 'numeric', 
          hour: '2-digit', 
          minute: '2-digit' 
        }) : 'Unknown time';
        
        let statusText = '';
        if (point.state === 'connected') {
          statusText = `Connected gateway (${timeStr})`;
        } else if (point.state === 'no_signal') {
          statusText = `Poor connection (${timeStr})`;
        } else {
          statusText = `No connectivity (starting ${timeStr})`;
        }
        
        setTooltip({
          visible: true,
          x: e.clientX,
          y: e.clientY - 40,
          content: statusText
        });
      }
    };

    const handleMouseLeave = () => {
      setTooltip({ visible: false, x: 0, y: 0, content: '' });
    };

    return (
      <div style={{ position: 'relative', marginTop: '4px' }}>
        <svg 
          ref={svgRef}
          width="100%" 
          height={chartHeight} 
          style={{ display: 'block', borderRadius: '1px', cursor: 'pointer' }}
          preserveAspectRatio="none"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          {(() => {
            const n = pointsWithState.length;
            if (n === 0) return null;

            return pointsWithState.map((point, idx) => {
              const xPercent = (idx / n) * 100;
              const widthPercent = (100 / n);
              
              let fillColor;
              if (point.state === 'offline') {
                fillColor = '#d1d5db'; // Gris - offline
              } else if (point.state === 'no_signal') {
                fillColor = '#ef4444'; // Rojo - conectado con problemas
              } else {
                fillColor = '#22c55e'; // Verde - conectado OK
              }

              return (
                <rect
                  key={`segment-${idx}`}
                  x={`${xPercent}%`}
                  y={0}
                  width={`${widthPercent}%`}
                  height="100%"
                  fill={fillColor}
                  shapeRendering="crispEdges"
                />
              );
            });
          })()}
        </svg>
        
        {/* Tooltip */}
        {tooltip.visible && (
          <div style={{
            position: 'fixed',
            left: tooltip.x,
            top: tooltip.y,
            transform: 'translateX(-50%)',
            background: '#fffbeb',
            border: '1px solid #fbbf24',
            borderRadius: '4px',
            padding: '6px 10px',
            fontSize: '12px',
            color: '#78350f',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 9999,
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
          }}>
            {tooltip.content}
          </div>
        )}
        
        {/* Eje X con timestamps */}
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          fontSize: '11px', 
          color: '#6b7280', 
          marginTop: '6px',
          paddingLeft: '2px',
          paddingRight: '2px'
        }}>
          {Array.from({ length: 6 }, (_, i) => {
            const pct = i * 20;
            const idx = Math.floor((points.length - 1) * pct / 100);
            const point = points[idx];
            if (!point) {
              return <span key={i}>--</span>;
            }
            const timestamp = point.ts || point.startTs || point.timestamp || point.time || point.endTs;
            const formatted = formatTimestamp(timestamp);
            return (
              <span 
                key={i} 
                style={{ 
                  textAlign: i === 0 ? 'left' : i === 5 ? 'right' : 'center',
                  minWidth: i === 0 || i === 5 ? 'auto' : '50px'
                }}
              >
                {formatted || '--'}
              </span>
            );
          })}
        </div>
      </div>
    );
  };

  const renderUplinkUsageChart = () => {
    if (!data.uplinkUsage || data.uplinkUsage.length === 0) {
      return (
        <div style={{ padding: '40px 20px', textAlign: 'center', color: '#94a3b8', fontSize: '14px' }}>
          Sin datos de uso de uplinks disponibles
        </div>
      );
    }

    const chartHeight = 200;
    const chartMarginTop = 10;
    const chartMarginBottom = 10;
    const actualChartHeight = chartHeight - chartMarginTop - chartMarginBottom;
    const points = data.uplinkUsage;
    
    // Calcular valores máximos en MB/s
    const intervalSeconds = 300; // 5 minutos
    
    // Procesar byInterface que puede ser array u objeto
    const maxReceivedMbps = Math.max(...points.flatMap(p => {
      const interfaces = Array.isArray(p.byInterface) ? p.byInterface : Object.values(p.byInterface || {});
      return interfaces.map(i => (i.received || 0) / intervalSeconds / 1048576);
    }), 0.1);
    
    const formatMbps = (mbps) => {
      if (mbps >= 1000) return `${Math.round(mbps / 1000)} Gb/s`;
      return `${Math.round(mbps)} Mb/s`;
    };

    // Calcular escala del eje Y (redondear hacia arriba a un número bonito)
    const maxScale = Math.ceil(maxReceivedMbps / 20) * 20;
    const gridLines = 5;
    const gridStep = maxScale / gridLines;

    // Agrupar datos por interfaz
    const wanInterfaces = {};
    points.forEach(p => {
      const interfaces = Array.isArray(p.byInterface) ? p.byInterface : [];
      interfaces.forEach(ifaceData => {
        const ifaceName = ifaceData.interface || 'unknown';
        if (!wanInterfaces[ifaceName]) wanInterfaces[ifaceName] = [];
        const receivedMbps = (ifaceData.received || 0) / intervalSeconds / 1048576;
        wanInterfaces[ifaceName].push({
          ts: p.ts,
          received: receivedMbps
        });
      });
    });

    // Color celeste brillante como Meraki original
    const colors = {
      wan1: '#00bcd4',  // Celeste brillante Material Design
      wan2: '#00bcd4',  // Celeste brillante Material Design
      cellular: '#ffc107'  // Amarillo
    };

    return (
      <div style={{ position: 'relative', marginTop: '20px' }}>
        {/* Leyenda - más visible */}
        <div style={{
          display: 'flex',
          gap: '20px',
          marginBottom: '16px',
          fontSize: '12px',
          justifyContent: 'flex-end',
          alignItems: 'center'
        }}>
          {Object.keys(wanInterfaces).map(iface => {
            // Formatear nombre de interfaz para mostrar
            let displayName = iface;
            if (iface.toLowerCase().startsWith('wan')) {
              displayName = iface.toUpperCase().replace('WAN', 'WAN ');
            } else {
              displayName = iface.charAt(0).toUpperCase() + iface.slice(1);
            }
            
            return (
              <div key={iface} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{
                  width: '14px',
                  height: '14px',
                  background: colors[iface.toLowerCase()] || '#64748b',
                  borderRadius: '3px',
                  border: '1px solid rgba(0,0,0,0.1)'
                }} />
                <span style={{ 
                  color: '#374151', 
                  textTransform: 'uppercase', 
                  fontSize: '11px', 
                  fontWeight: '600', 
                  letterSpacing: '0.5px' 
                }}>
                  {displayName}
                </span>
              </div>
            );
          })}
        </div>

        {/* Gráfica con grid */}
        <div style={{ position: 'relative' }}>
          {/* Etiquetas del eje Y */}
          <div style={{
            position: 'absolute',
            left: '-55px',
            top: chartMarginTop,
            height: actualChartHeight,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            fontSize: '11px',
            color: '#6b7280',
            textAlign: 'right',
            width: '50px',
            fontWeight: '500'
          }}>
            {Array.from({ length: gridLines + 1 }).map((_, i) => (
              <span key={i} style={{ transform: 'translateY(-50%)' }}>
                {formatMbps(maxScale - (i * gridStep))}
              </span>
            ))}
          </div>

          <svg width="100%" height={chartHeight} viewBox={`0 0 100 ${chartHeight}`} preserveAspectRatio="none" style={{ display: 'block' }}>
            <defs>
              {Object.keys(wanInterfaces).map(iface => (
                <linearGradient key={iface} id={`gradient-${iface}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={colors[iface.toLowerCase()] || '#64748b'} stopOpacity="0.2" />
                  <stop offset="100%" stopColor={colors[iface.toLowerCase()] || '#64748b'} stopOpacity="0.02" />
                </linearGradient>
              ))}
            </defs>
            
            {/* Grid lines horizontales */}
            {Array.from({ length: gridLines + 1 }).map((_, i) => {
              const y = chartMarginTop + (i * actualChartHeight / gridLines);
              return (
                <line
                  key={i}
                  x1="0"
                  y1={y}
                  x2="100"
                  y2={y}
                  stroke="#e5e7eb"
                  strokeWidth="0.3"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
            
            {/* Líneas de datos */}
            {Object.entries(wanInterfaces).map(([iface, ifacePoints]) => {
              const pathData = ifacePoints.map((point, idx) => {
                const x = (idx / Math.max(ifacePoints.length - 1, 1)) * 100;
                const yValue = chartMarginTop + actualChartHeight - ((point.received / maxScale) * actualChartHeight);
                return `${idx === 0 ? 'M' : 'L'} ${x} ${yValue}`;
              }).join(' ');

              const fillPath = `${pathData} L 100 ${chartHeight - chartMarginBottom} L 0 ${chartHeight - chartMarginBottom} Z`;

              return (
                <g key={iface}>
                  {/* Área sombreada */}
                  <path
                    d={fillPath}
                    fill={`url(#gradient-${iface})`}
                  />
                  {/* Línea */}
                  <path
                    d={pathData}
                    fill="none"
                    stroke={colors[iface.toLowerCase()] || '#64748b'}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              );
            })}
          </svg>

          {/* Etiquetas del eje X - Tiempo */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '11px',
            color: '#6b7280',
            marginTop: '8px',
            fontWeight: '500'
          }}>
            {[0, 16, 33, 50, 66, 83, 100].map(pct => {
              const idx = Math.floor((points.length - 1) * pct / 100);
              const point = points[idx];
              if (!point) return <span key={pct} style={{ minWidth: '40px' }}></span>;
              const formatted = formatTimestamp(point.ts);
              return (
                <span key={pct} style={{ minWidth: '40px', textAlign: 'center' }}>
                  {formatted || ''}
                </span>
              );
            })}
          </div>
        </div>

        {/* Max value display */}
        <div style={{
          fontSize: '10px',
          color: '#9ca3af',
          marginTop: '6px',
          textAlign: 'right'
        }}>
          Max: {formatMbps(maxReceivedMbps)}
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div style={{ padding: '40px', textAlign: 'center' }}>
        <div className="spinner" />
        <div style={{ marginTop: '12px', color: '#64748b' }}>Cargando datos historicos...</div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: '24px' }}>
      {/* Header estilo Meraki */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '16px'
      }}>
        <h3 style={{ 
          margin: 0, 
          fontSize: '18px', 
          fontWeight: '400', 
          color: '#111827',
          letterSpacing: '-0.01em'
        }}>
          Historical device data
        </h3>
        
        {/* Dropdown estilo Meraki */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            style={{
              padding: '6px 32px 6px 12px',
              borderRadius: '4px',
              border: '1px solid #d1d5db',
              fontSize: '13px',
              color: '#374151',
              background: 'white',
              cursor: 'pointer',
              fontFamily: 'inherit',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              position: 'relative'
            }}
          >
            {getTimespanLabel()}
            <span style={{ 
              position: 'absolute',
              right: '10px',
              fontSize: '10px',
              color: '#6b7280'
            }}>▼</span>
          </button>
          
          {dropdownOpen && (
            <>
              <div 
                style={{
                  position: 'fixed',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  zIndex: 999
                }}
                onClick={() => setDropdownOpen(false)}
              />
              <div style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: '4px',
                background: 'white',
                border: '1px solid #d1d5db',
                borderRadius: '4px',
                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
                minWidth: '180px',
                zIndex: 1000,
                overflow: 'hidden'
              }}>
                {timespanOptions.map((option) => (
                  <div
                    key={option.value}
                    onClick={() => {
                      setTimespan(option.value);
                      setDropdownOpen(false);
                    }}
                    style={{
                      padding: '8px 12px',
                      fontSize: '13px',
                      color: '#374151',
                      cursor: 'pointer',
                      background: timespan === option.value ? '#f3f4f6' : 'white',
                      fontWeight: timespan === option.value ? '500' : '400'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = '#f9fafb'}
                    onMouseLeave={(e) => e.currentTarget.style.background = timespan === option.value ? '#f3f4f6' : 'white'}
                  >
                    {option.label}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Connectivity Chart */}
      <div style={{
        background: 'white',
        borderRadius: '6px',
        padding: '16px 20px',
        marginBottom: '16px',
        border: '1px solid #e5e7eb'
      }}>
        <h4 style={{ 
          margin: '0 0 12px 0', 
          fontSize: '13px', 
          fontWeight: '600', 
          color: '#4b5563'
        }}>
          Connectivity
        </h4>
        {renderConnectivityChart()}
      </div>

      {/* Client Usage Chart */}
      <div style={{
        background: 'white',
        borderRadius: '6px',
        padding: '16px 20px 16px 60px',
        border: '1px solid #e5e7eb'
      }}>
        <h4 style={{ 
          margin: '0 0 12px 0', 
          fontSize: '13px', 
          fontWeight: '600', 
          color: '#4b5563',
          marginLeft: '-40px'
        }}>
          Client usage
        </h4>
        {renderUplinkUsageChart()}
      </div>
    </div>
  );
};

export default ApplianceHistoricalCharts;
