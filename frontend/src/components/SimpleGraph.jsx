import { useMemo } from 'react';

const KIND_ORDER = {
  external: 0,
  appliance: 1,
  gateway: 1,
  switch: 2,
  bridge: 3,
  ap: 4,
  camera: 5,
  sensor: 6,
  device: 7
};

const STATUS_COLOR = {
  online: '#45991f',
  connected: '#45991f',
  ready: '#45991f',
  alerting: '#f59e0b',
  warning: '#f59e0b',
  degraded: '#f59e0b',
  offline: '#e74c3c',
  down: '#e74c3c'
};

const SERIAL_PATTERN = /^[A-Z0-9]{2,}(?:-[A-Z0-9]{2,}){2,}$/i;

const looksLikeSerial = (value) => {
  if (!value) return false;
  const text = value.toString().trim();
  if (!text) return false;
  if (SERIAL_PATTERN.test(text)) return true;
  const compact = text.replace(/[^a-z0-9]/gi, '');
  return compact.length >= 10 && /[a-z]/i.test(compact) && /\d/.test(compact);
};

const computeNodeLabels = (node = {}) => {
  const meta = node.meta || {};
  const serial = (node.serial || meta.serial || node.id || '').toString().trim();
  const mac = (node.mac || meta.mac || '').toString().trim();
  const modelLower = (node.model || meta.model || '').toString().toLowerCase();
  
  const isZ3Utm = modelLower.startsWith('z') || 
                  modelLower.includes('utm') || 
                  modelLower.includes('z3') || 
                  modelLower.includes('z4') ||
                  modelLower.includes('teleworker') ||
                  modelLower.startsWith('mx');
  
  const nameCandidates = [
    node.name,
    meta.name,
    node.label,
    meta.description,
    node.model,
    meta.model,
    node.productType,
    Array.isArray(node.productTypes) ? node.productTypes[0] : null,
  ]
    .map((candidate) => (candidate || '').toString().trim())
    .filter(Boolean);

  let primary = nameCandidates.find((candidate) => candidate && !looksLikeSerial(candidate) && candidate !== serial);
  if (!primary) {
    // Para Z3/UTM sin nombre, usar MAC
    if (isZ3Utm && mac) {
      primary = mac;
    } else {
      primary = serial || node.label || node.model || node.id || 'Device';
    }
  }

  // Mostrar serial y MAC debajo de TODOS los dispositivos
  let secondary = null;
  let tertiary = null;
  
  // No mostrar info adicional para nodos externos (Internet)
  if (node.kind !== 'external') {
    // Priorizar Serial primero, luego MAC
    if (serial && serial !== primary && !looksLikeSerial(primary)) {
      secondary = `S: ${serial}`;
      // Si también hay MAC, mostrarla en tercera línea
      if (mac && mac !== primary && mac !== serial) {
        tertiary = `M: ${mac}`;
      }
    } else if (mac && mac !== primary) {
      // Si no hay serial o el primary ya es el serial, mostrar MAC
      secondary = `M: ${mac}`;
    }
  }

  if (secondary === primary) secondary = null;
  if (tertiary === primary || tertiary === secondary) tertiary = null;

  return { primary, secondary, tertiary };
};

const classifyKind = (node = {}) => {
  const rawType = (node.type || '').toLowerCase();
  const modelLower = (node.model || '').toString().toLowerCase();
  const productType = (node.productType || '').toString().toLowerCase();
  const productTypes = Array.isArray(node.productTypes) ? node.productTypes.map((item) => item.toString().toLowerCase()) : [];
  const metaProductTypes = Array.isArray(node.meta?.productTypes) ? node.meta.productTypes.map((item) => item.toString().toLowerCase()) : [];
  const tags = Array.isArray(node.meta?.tags) ? node.meta.tags.map((tag) => tag.toString().toLowerCase()) : [];

  const text = [
    node.model,
    node.label,
    node.name,
    node.id,
    node.serial,
    rawType,
    productType,
    ...productTypes,
    ...metaProductTypes,
    ...tags,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (rawType === 'external' || text.includes('wan') || text.includes('internet')) return 'external';
  if (modelLower.startsWith('mx') || text.includes('gateway') || text.includes('gtw')) return 'gateway';
  if (modelLower.startsWith('ms') || text.includes('switch')) return 'switch';
  if (modelLower.startsWith('mr') || text.includes('access point') || text.includes('ap_') || text.includes(' mr')) return 'ap';
  if (modelLower.startsWith('mv') || text.includes('camera')) return 'camera';
  if (modelLower.startsWith('mt') || text.includes('sensor')) return 'sensor';
  if (modelLower.startsWith('z') || text.includes('z3') || text.includes('z4') || text.includes('utm') || text.includes('teleworker') || text.includes('security appliance')) return 'appliance';
  if (rawType === 'mx') return 'gateway';
  if (rawType === 'ms') return 'switch';
  if (rawType === 'mr') return 'ap';
  if (productType === 'gateway' || productTypes.includes('gateway') || metaProductTypes.includes('gateway')) return 'gateway';
  if (productType === 'appliance' || productTypes.includes('appliance') || metaProductTypes.includes('appliance')) return 'appliance';
  if (productType === 'switch' || productTypes.includes('switch') || metaProductTypes.includes('switch')) return 'switch';
  if (productType === 'wireless' || productTypes.includes('wireless')) return 'ap';
  return rawType || 'device';
};

const cmpNodes = (nodeLookup) => (aId, bId) => {
  const a = nodeLookup.get(aId) || {};
  const b = nodeLookup.get(bId) || {};
  
  // Prioridad 1: si ambos tienen switchPort, ordenar solo por número de puerto
  // Applies to all devices connected to a switch (APs, switches, MR, etc.)
  if (a.switchPort != null && b.switchPort != null) {
    return a.switchPort - b.switchPort;
  }
  
  // Prioridad 2: si solo uno tiene switchPort, el que tiene puerto va primero
  if (a.switchPort != null) return -1;
  if (b.switchPort != null) return 1;
  
  // Prioridad 3: ordenamiento normal por tipo y luego por nombre (solo si ninguno tiene puerto)
  const orderA = KIND_ORDER[a.kind || 'device'] ?? KIND_ORDER.device;
  const orderB = KIND_ORDER[b.kind || 'device'] ?? KIND_ORDER.device;
  if (orderA !== orderB) return orderA - orderB;
  const labelA = (a.label || a.id || '').toLowerCase();
  const labelB = (b.label || b.id || '').toLowerCase();
  return labelA.localeCompare(labelB, undefined, { numeric: true, sensitivity: 'base' });
};

const statusColorOf = (status) => STATUS_COLOR[status?.toLowerCase?.()] || '#7f8c8d';

const buildLayout = (graph, deviceMap = new Map()) => {
  const rawNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const rawLinks = Array.isArray(graph?.links) ? graph.links : [];
  if (!rawNodes.length) {
    return { nodes: [], links: [], width: 560, height: 320 };
  }

  const nodeMap = new Map();
  rawNodes.forEach((node) => {
    const id = node?.id || node?.serial;
    if (!id) return;
    const serial = (node.serial || id).toString().trim();
    const serialUpper = serial.toUpperCase();
    const meta = deviceMap.get(serialUpper) || deviceMap.get(serial) || null;
    const metaProductTypesRaw = meta?.productTypes || meta?.productType || null;
    const metaProductTypes = Array.isArray(metaProductTypesRaw)
      ? metaProductTypesRaw
      : (metaProductTypesRaw ? [metaProductTypesRaw] : []);
    const model = node.model || meta?.model || null;
    const name = node.name || meta?.name || null;
    const productType = node.productType || meta?.productType || (metaProductTypes.length ? metaProductTypes[0] : null);
    const productTypes = node.productTypes || metaProductTypes;
    const label = node.label || name || model || serial || id;
    const enriched = {
      ...node,
      id,
      serial,
      label,
      name,
      model,
      productType,
      productTypes,
      meta,
    };
    const kind = classifyKind(enriched);
    nodeMap.set(id, { ...enriched, kind });
  });

  if (!nodeMap.size) {
    return { nodes: [], links: [], width: 560, height: 320 };
  }

  const adjacency = new Map();
  const ensureAdj = (id) => {
    if (!adjacency.has(id)) adjacency.set(id, new Set());
    return adjacency.get(id);
  };

  rawLinks.forEach((link) => {
    const source = link?.source;
    const target = link?.target;
    if (!nodeMap.has(source) || !nodeMap.has(target)) return;
    ensureAdj(source).add(target);
    ensureAdj(target).add(source);
  });

  nodeMap.forEach((_, id) => ensureAdj(id));

  const pickRoot = () => {
    const nodes = [...nodeMap.values()];
    const degreeOf = (id) => ensureAdj(id).size;
    const byDegreeDesc = (a, b) => degreeOf(b.id) - degreeOf(a.id);

    const isApplianceLike = (node) => {
      const text = [node.kind, node.type, node.model, node.label, node.id]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return (
        node.kind === 'appliance'
        || node.kind === 'gateway'
        || /\b(mx|utm|z[23]|teleworker|security\s*appliance)\b/.test(text)
      );
    };

    const appliances = nodes.filter((node) => isApplianceLike(node) && degreeOf(node.id) > 0);
    if (appliances.length) {
      appliances.sort(byDegreeDesc);
      return appliances[0];
    }

    const priorityKinds = ['appliance', 'gateway', 'switch'];
    for (const kind of priorityKinds) {
      const candidate = nodes.find((n) => n.kind === kind && degreeOf(n.id) > 0);
      if (candidate) return candidate;
    }

    return nodes.sort(byDegreeDesc)[0];
  };

  const rootNode = pickRoot();
  if (!rootNode) {
    return { nodes: [], links: [], width: 560, height: 320 };
  }

  ensureAdj(rootNode.id);

  const hasExternal = [...nodeMap.values()].some((node) => node.kind === 'external');
  if (!hasExternal) {
    let externalId = '__external__';
    let idx = 1;
    while (nodeMap.has(externalId)) {
      externalId = `__external_${idx++}`;
    }
    const externalNode = {
      id: externalId,
      label: 'Internet',
      kind: 'external',
      status: 'online',
      synthetic: true
    };
    nodeMap.set(externalId, externalNode);
    ensureAdj(externalId).add(rootNode.id);
    ensureAdj(rootNode.id).add(externalId);
  }

  const depth = new Map();
  const parent = new Map();
  const queue = [rootNode.id];
  depth.set(rootNode.id, 0);
  parent.set(rootNode.id, null);

  while (queue.length) {
    const current = queue.shift();
    (adjacency.get(current) || []).forEach((neighbor) => {
      if (depth.has(neighbor)) return;
      depth.set(neighbor, (depth.get(current) || 0) + 1);
      parent.set(neighbor, current);
      queue.push(neighbor);
    });
  }

  nodeMap.forEach((_node, id) => {
    if (!depth.has(id)) {
      depth.set(id, 1);
      parent.set(id, rootNode.id);
    }
  });

  depth.forEach((lvl, id) => {
    const node = nodeMap.get(id);
    if (!node) return;
    if (node.kind === 'external') {
      depth.set(id, -1);
    }
  });

  const children = new Map();
  parent.forEach((pId, id) => {
    if (pId === null || pId === undefined) return;
    if (!children.has(pId)) children.set(pId, []);
    children.get(pId).push(id);
  });

  const compare = cmpNodes(nodeMap);
  children.forEach((kids) => {
    kids.sort(compare);
  });

  const yPositions = new Map();
  let nextLeafY = 50;
  
  // Sistema de escalado dinámico basado en cantidad de dispositivos
  const totalDevices = nodeMap.size;
  const apCount = Array.from(nodeMap.values()).filter(n => n.kind === 'ap').length;
  
  // Factor de escala y espaciado optimizado basado en APs (más crítico que switches)
  let scaleFactor = 1.0;
  let yGap = 75;
  
  if (apCount <= 4) {
    // Redes pequeñas (<=4 APs): más separación vertical para evitar solapado
    // Mantener iconos ligeramente más grandes para legibilidad
    scaleFactor = 0.85;
    yGap = 140; // aumentado para mayor separación en redes con pocos APs
  } else if (apCount <= 6) {
    // Pequeñas-medianas (5-6 APs): algo más de separación vertical y etiquetas un poco más arriba
    scaleFactor = 0.9;
    yGap = 150;
  } else if (apCount <= 12) {
    // Redes medianas (5-12 APs): más espaciado - caso 613074 con 10 APs
    scaleFactor = 0.85;
    yGap = 120;  // Incrementado para separar bien 10 APs
  } else if (apCount <= 20) {
    // Redes medianas-grandes (13-20 APs): espaciado generoso - caso con 17 APs
    scaleFactor = 1.0;
    yGap = 140;
  } else if (apCount <= 40) {
    // Redes grandes (21-40 APs): mucho espaciado
    scaleFactor = 1.2;
    yGap = 180;
  } else if (apCount <= 60) {
    // Large networks (41-60 APs): maximum spacing
    scaleFactor = 1.3;
    yGap = 220;
  } else {
    // Redes enormes (>60 APs): ultra espaciado
    scaleFactor = 1.5;
    yGap = 270;
  }

  const assignY = (id) => {
    const node = nodeMap.get(id);
    const kids = children.get(id) || [];
    
    // Si es un switch con switchPort (hijo de otro switch), tratarlo como hoja
    // para que reciba una posición Y secuencial en lugar de promedio de sus hijos
    if (node?.switchPort != null && node?.kind === 'switch') {
      const y = nextLeafY;
      yPositions.set(id, y);
      nextLeafY += yGap;
      // Procesar sus hijos DESPUÉS para que aparezcan debajo
      kids.forEach(kidId => assignY(kidId));
      return y;
    }
    
    // Comportamiento normal para nodos sin hijos (APs, etc.)
    if (!kids.length) {
      const y = nextLeafY;
      yPositions.set(id, y);
      nextLeafY += yGap;
      return y;
    }
    
    // Para switches principales (sin switchPort), calcular como promedio
    const acc = kids.map(assignY);
    const y = acc.reduce((sum, value) => sum + value, 0) / acc.length;
    yPositions.set(id, y);
    return y;
  };

  assignY(rootNode.id);

  // Primero guardar los switches que deben alinearse manualmente después
  const switchesToAlignLater = new Set();
  const allSwitches = Array.from(nodeMap.entries())
    .filter(([, node]) => node.kind === 'switch')
    .map(([id, node]) => ({ id, label: node.label || '' }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  
  // Todos, excepto el primero, se alinearán manualmente después
  allSwitches.slice(1).forEach(sw => switchesToAlignLater.add(sw.id));

  const backboneKinds = new Set(['appliance', 'gateway', 'switch', 'bridge']);
  const alignBackbone = (id) => {
    const kids = children.get(id) || [];
    if (!kids.length) return;
    const parentNode = nodeMap.get(id);

    const backboneKids = kids.filter((childId) => backboneKinds.has(nodeMap.get(childId)?.kind));

    if (backboneKids.length === 1) {
      const childId = backboneKids[0];
      const childNode = nodeMap.get(childId);
      
      // ALINEAR switches principales (sin switchPort) con su padre
      // NO alinear switches hijos (con switchPort) para mantener orden secuencial
      if (childNode?.switchPort != null) {
        // Skip - mantener posición secuencial original
      } else if (switchesToAlignLater.has(childId)) {
        // Skip - este switch se alineará más tarde
      } else if (parentNode && childNode && backboneKinds.has(parentNode.kind)) {
        const parentY = yPositions.get(id);
        if (parentY !== undefined) {
          yPositions.set(childId, parentY);
        }
      }
    }

    kids.forEach((childId) => alignBackbone(childId));
  };
  alignBackbone(rootNode.id);

  nodeMap.forEach((_node, id) => {
    if (!yPositions.has(id)) {
      const parentId = parent.get(id);
      const fallback = parentId ? yPositions.get(parentId) || nextLeafY : nextLeafY;
      yPositions.set(id, fallback);
      if (!parentId) nextLeafY += yGap;
    }
  });

  const shiftSubtree = (nodeId, delta) => {
    if (!delta) return;
    const currentY = yPositions.get(nodeId) || 0;
    yPositions.set(nodeId, currentY + delta);
    const descendants = children.get(nodeId) || [];
    descendants.forEach((childId) => shiftSubtree(childId, delta));
  };

  // Función para obtener la Y máxima de un nodo y todos sus descendientes
  const getMaxY = (nodeId) => {
    const nodeY = yPositions.get(nodeId) || 0;
    const kids = children.get(nodeId) || [];
    if (kids.length === 0) return nodeY;
    const kidsMaxY = Math.max(...kids.map(getMaxY));
    return Math.max(nodeY, kidsMaxY);
  };

  const enforceSiblingSpacing = (nodeId) => {
    const kids = (children.get(nodeId) || []).slice();
    if (!kids.length) return;
    kids.sort((a, b) => (yPositions.get(a) || 0) - (yPositions.get(b) || 0));
  
    // Espaciado uniforme para todos los hijos, sin importar el tipo
  // Para redes pequeñas/medianitas con pocos APs, usar un minSpacing mayor
  const minSpacing = apCount <= 6 ? 120 : 55;
    
    for (let i = 1; i < kids.length; i += 1) {
      const prevId = kids[i - 1];
      const currentId = kids[i];
      
      // La posición del nodo actual debe estar al menos 55px DESPUÉS
      // del último descendiente del nodo anterior (no del nodo anterior en sí)
      const prevMaxY = getMaxY(prevId);
      const currentY = yPositions.get(currentId) || 0;
      const gap = currentY - prevMaxY;
      
      if (gap < minSpacing) {
        const shift = minSpacing - gap;
        shiftSubtree(currentId, shift);
      }
    }
    kids.forEach((childId) => enforceSiblingSpacing(childId));
  };

  enforceSiblingSpacing(rootNode.id);

  const levels = Array.from(depth.values());
  const minLevel = Math.min(...levels);
  const maxLevel = Math.max(...levels);
  
  // ESPACIADO HORIZONTAL MÁXIMO - VERSIÓN 3.0
  const deviceLevels = maxLevel - minLevel + 1;
  let xGap = 700; // MUCHO MÁS ANCHO
  if (deviceLevels <= 3) xGap = 650;
  if (deviceLevels >= 5) xGap = 750;
  
  const marginX = 40; // Margen inicial
  const marginRight = 40; // Margen final
  let width = (deviceLevels - 1) * xGap + marginX + marginRight;
  let height = Math.max(nextLeafY + 80, 400);

  const layoutNodes = [];
  depth.forEach((lvl, id) => {
    const node = nodeMap.get(id);
    if (!node) return;
    const x = marginX + (lvl - minLevel) * xGap;
    const y = yPositions.get(id) ?? marginX;
    // Attach the scaleFactor to each node so render-time helpers (anchors/links)
    // can adapt to visual scaling of node shapes.
    layoutNodes.push({ ...node, level: lvl, x, y, parentId: parent.get(id), scale: scaleFactor });
  });

  // REDISTRIBUIR hijos de TODOS los switches para que queden arriba/abajo
  allSwitches.forEach(switchInfo => {
    const switchId = switchInfo.id;
    const switchLayout = layoutNodes.find(n => n.id === switchId);
    const switchKids = children.get(switchId) || [];
    
    if (switchLayout && switchKids.length > 0) {
      const switchY = switchLayout.y;
      const totalKids = switchKids.length;
      const halfKids = Math.floor(totalKids / 2);
      
      // Calcular posición inicial (arriba del switch)
      let newY = switchY - (halfKids * yGap);
      
      // Crear mapa de nuevas posiciones
      const newPositions = new Map();
      
      for (let i = 0; i < totalKids; i++) {
        const kidId = switchKids[i];
        newPositions.set(kidId, newY);
        
        newY += yGap;
        
        // Espacio del switch padre en el medio
        if (i === halfKids - 1) {
          newY += yGap;
        }
      }
      
      // Aplicar nuevas posiciones a layoutNodes
      layoutNodes.forEach(node => {
        if (newPositions.has(node.id)) {
          const oldY = node.y;
          node.y = newPositions.get(node.id);
          
          // Mover también sus descendientes
          const delta = node.y - oldY;
          if (delta !== 0) {
            const descendants = layoutNodes.filter(n => {
              let curr = n.parentId;
              while (curr) {
                if (curr === node.id) return true;
                const parentNode = layoutNodes.find(p => p.id === curr);
                curr = parentNode?.parentId;
              }
              return false;
            });
            descendants.forEach(d => d.y += delta);
          }
        }
      });
    }
  });

  const rootLayout = layoutNodes.find((node) => node.id === rootNode.id);
  if (rootLayout) {
    const externalNodes = layoutNodes.filter((node) => node.kind === 'external');
    if (externalNodes.length) {
      const externalGap = 44;
      externalNodes.forEach((node, index) => {
        node.x = rootLayout.x - 170;
        node.y = rootLayout.y + (index - (externalNodes.length - 1) / 2) * externalGap;
      });
    }

    const applianceChildren = layoutNodes.filter(
      (node) => (node.kind === 'appliance' || node.kind === 'gateway') && node.parentId === rootNode.id
    );

    if (applianceChildren.length) {
      const gapY = 32;
      const anchorY = rootLayout.y;
      const startY = anchorY - ((applianceChildren.length - 1) * gapY) / 2;
      applianceChildren.forEach((node, index) => {
        node.x = rootLayout.x + xGap;
        node.y = startY + index * gapY;
      });
    }
  }

  resolveNodeOverlap(layoutNodes);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  layoutNodes.forEach((node) => {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  });

  const paddingLeft = 30;
  const paddingRight = 250;  // Aumentado de 100 a 250 para dar espacio a etiquetas de APs de la derecha
  const paddingTop = 150;  // Aumentado de 50 a 150 para dar espacio a las etiquetas
  const paddingBottom = 200;  // Espacio inferior generoso para dispositivos en la parte baja con todas sus etiquetas

  // Normalizar: mover todo para que minX quede en paddingLeft
  const shiftX = paddingLeft - minX;
  let shiftY = paddingTop - minY;

  // Si es predio GAP/GTW (Z3) y solo hay 1 AP, agregar margen extra arriba
  const isGAPorGTW = layoutNodes.some(n => n.kind === 'gateway' || n.model?.toUpperCase().includes('Z3'));
  const apCountForMargin = layoutNodes.filter(n => n.kind === 'ap').length;
  if (isGAPorGTW && apCountForMargin === 1) {
    shiftY += 40; // margen extra arriba
  }

  layoutNodes.forEach((node) => {
    node.x += shiftX;
    node.y += shiftY;
  });
  
  // Alinear el primer switch con el MX/UTM y mover todo el conjunto downstream
  const firstSwitch = allSwitches.length > 0 ? allSwitches[0].id : null;
  if (firstSwitch) {
    const firstSwitchLayout = layoutNodes.find(n => n.id === firstSwitch);
    const firstSwitchParent = parent.get(firstSwitch);
    const parentLayout = layoutNodes.find(n => n.id === firstSwitchParent);
    
    if (firstSwitchLayout && parentLayout) {
      const deltaY = parentLayout.y - firstSwitchLayout.y;
      
      if (deltaY !== 0) {
  // Mover el primer switch y todos los switches downstream (toda la cascada)
        const toMove = new Set();
        
  // Agregar el primer switch y todos sus descendientes (directos e indirectos)
        const addDescendants = (nodeId) => {
          toMove.add(nodeId);
          const kids = children.get(nodeId) || [];
          kids.forEach(kidId => addDescendants(kidId));
        };
        addDescendants(firstSwitch);
        
          // Aplicar el desplazamiento a todos los nodos seleccionados
        layoutNodes.forEach(node => {
          if (toMove.has(node.id)) {
            node.y += deltaY;
          }
        });
      }
    }
  }
  
  // Recalcular minX, maxX, minY, maxY después del shift
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;
  layoutNodes.forEach((node) => {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  });

  // Calcular ancho y alto real necesario desde las posiciones mínimas
  // Como el viewBox ya comienza desde minY - paddingTop, solo necesitamos
  // la diferencia de posiciones + paddingBottom para el espacio inferior
  width = maxX - minX + paddingLeft + paddingRight;
  height = maxY - minY + paddingBottom;

  layoutNodes.sort((a, b) => (a.level - b.level) || compare(a.id, b.id));
  const lookup = new Map(layoutNodes.map((node) => [node.id, node]));

  const layoutLinks = [];
  parent.forEach((pId, id) => {
    if (pId === null || pId === undefined) return;
    const source = lookup.get(pId);
    const target = lookup.get(id);
    if (!source || !target) return;
    layoutLinks.push({ source, target });
  });

  const executionId = Math.random().toString(36).substr(2, 6);

  return { 
    nodes: layoutNodes, 
    links: layoutLinks, 
    width, 
    height, 
    executionId,
    viewBoxX: minX - paddingLeft,  // Comenzar viewBox desde donde están los elementos
    viewBoxY: minY - paddingTop,   // Comenzar viewBox desde donde están los elementos
    scaleFactor: scaleFactor, // Factor de escala para elementos visuales
    apCount: apCount, // Cantidad de APs para ajustar espaciado de etiquetas
    totalDevices: totalDevices, // Total de dispositivos
  };
};

const resolveNodeOverlap = (nodes = []) => {
  const buckets = new Map();
  nodes.forEach((node) => {
    const key = `${Math.round(node.x)}:${Math.round(node.y)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(node);
  });

  buckets.forEach((group) => {
    if (!group || group.length < 2) return;
    
    // NO mover switches que fueron posicionados manualmente
    const hasSwitches = group.some(n => n.kind === 'switch');
    if (hasSwitches) return;
    
    // Reduced overlap spacing
    const step = group.length > 5 ? 20 : 30;
    const center = (group.length - 1) / 2;
    group.sort((a, b) => (a.level - b.level) || a.id.localeCompare(b.id));
    group.forEach((node, index) => {
      const offset = (index - center) * step;
      node.y += offset;
    });
  });
};

const getNodeDimensions = (node = {}) => {
  // TAMAÑOS GIGANTES - VERSIÓN 2.0
  if (node.kind === 'appliance' || node.kind === 'gateway') return { width: 70, height: 42 };
  if (node.kind === 'switch' || node.kind === 'bridge') return { width: 84, height: 49 };
  if (node.kind === 'camera') return { width: 56, height: 39 };
  if (node.kind === 'sensor') return { width: 56, height: 56 };
  if (node.kind === 'external') return { width: 35, height: 35 };
  return { width: 49, height: 49 }; // APs
};

const anchorForNode = (node, direction = 1) => {
  const { width } = getNodeDimensions(node);
  const nodeScale = node?.scale || 1;
  const padding = 18; // Incrementado para mayor separación de las líneas
  // Aplicar escala visual al ancho y al padding para mantener coherencia con NodeShape
  const offset = (width * nodeScale) / 2 + padding * nodeScale;
  return {
    x: node.x + direction * offset,
    y: node.y,
  };
};

const buildLinkPath = (source, target) => {
  if (!source || !target) return '';
  const direction = source.x <= target.x ? 1 : -1;
  const start = anchorForNode(source, direction);
  const end = anchorForNode(target, -direction);
  const dx = Math.abs(end.x - start.x);
  const controlDistance = Math.max(60, dx / 2);
  const dy = end.y - start.y;
  const curvature = dy * 0.25;
  const c1x = start.x + direction * controlDistance;
  const c1y = start.y + curvature;
  const c2x = end.x - direction * controlDistance;
  const c2y = end.y - curvature;
  return `M ${start.x} ${start.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${end.x} ${end.y}`;
};

export default function SimpleGraph({ graph, devices = [] }) {
  const deviceMap = useMemo(() => {
    const map = new Map();
    devices.forEach((device) => {
      if (!device || !device.serial) return;
      const serial = device.serial.toString();
      map.set(serial, device);
      map.set(serial.toUpperCase(), device);
    });
    return map;
  }, [devices]);

  const layout = useMemo(() => buildLayout(graph, deviceMap), [graph, deviceMap]);

  if (!layout.nodes.length) {
    return null;
  }

  // Extraer valores del layout para usar en renderizado
  const { apCount = 0, totalDevices = 0 } = layout;

  const viewBox = `${layout.viewBoxX || 0} ${layout.viewBoxY || 0} ${layout.width} ${layout.height}`;

  return (
    <svg 
      width="100%" 
      height={layout.height}
      viewBox={viewBox} 
      preserveAspectRatio="xMidYMin meet"
      style={{ display: 'block', maxHeight: `${layout.height}px` }}
    >
      <g fill="none" stroke="#cfd8dc" strokeWidth="2" strokeLinecap="round">
        {layout.links.map(({ source, target }) => {
          const path = buildLinkPath(source, target);
          return <path key={`${source.id}-${target.id}`} d={path} />;
        })}
      </g>

      {layout.nodes.map((node) => {
        const color = statusColorOf(node.status);
        const isExternal = node.kind === 'external';
        
        // Todos los labels centrados arriba del icono (excepto external que va a la izquierda)
        let textAnchor = 'middle';
        let labelX = 0;
        
  // Aplicar factor de escala dinámico a fuentes
  const baseScale = layout.scaleFactor || 1.0;
  // Icon scale: 1.25 solo cuando hay 1 AP; para predios pequeños/medianos usar 1.0
  const iconScale = (apCount === 1) ? baseScale * 1.25 : baseScale * 1.0;
        const totalDevices = layout.nodes.length;
        
        // Calcular espaciado dinámico basado en cantidad de APs
        let primaryY = -32;
        let secondaryY = -8;
        let tertiaryY = 8;
        
        // Ajustar espaciado según cantidad de APs para mantener etiquetas arriba del dispositivo
        if (apCount <= 4) {
          // Small networks (<=4 APs): labels above with increased separation
          primaryY = -76;
          secondaryY = -48;
          tertiaryY = -24;
        } else if (apCount <= 6) {
          // Redes pequeñas con 5-6 APs: subir ligeramente las etiquetas y mejorar separación
          primaryY = -84;
          secondaryY = -52;
          tertiaryY = -28;
        } else if (apCount <= 8) {
          // Redes medianas pequeñas (5-8 APs): separación suave
          primaryY = -60;
          secondaryY = -35;
          tertiaryY = -10;
        } else if (apCount <= 12) {
          // Redes medianas (9-12 APs): más separación - caso 613074 con 9-10 APs
          primaryY = -65;
          secondaryY = -40;
          tertiaryY = -15;
        } else if (apCount <= 20) {
          // Redes medianas-grandes (13-20 APs): perfecto para 17 APs - caso 603005
          primaryY = -70;
          secondaryY = -45;
          tertiaryY = -20;
        } else if (apCount <= 30) {
          // Redes grandes (21-30 APs): más separación
          primaryY = -85;
          secondaryY = -55;
          tertiaryY = -25;
        } else if (apCount <= 40) {
          // Redes grandes (31-40 APs): gran separación
          primaryY = -95;
          secondaryY = -65;
          tertiaryY = -35;
        } else if (apCount <= 60) {
          // Redes muy grandes (41-60 APs): máxima separación
          primaryY = -110;
          secondaryY = -75;
          tertiaryY = -40;
        } else {
          // Redes enormes (>60 APs): ultra separación
          primaryY = -125;
          secondaryY = -90;
          tertiaryY = -55;
        }
        
        // Fuentes adaptativas basadas en cantidad de APs
        let primaryFontSize = 20;
        let secondaryFontSize = 16;
        let tertiaryFontSize = 16;
        
        if (apCount > 60) {
          primaryFontSize = 24;
          secondaryFontSize = 20;
          tertiaryFontSize = 20;
        } else if (apCount > 40) {
          primaryFontSize = 23;
          secondaryFontSize = 19;
          tertiaryFontSize = 19;
        } else if (apCount > 20) {
          primaryFontSize = 22;
          secondaryFontSize = 18;
          tertiaryFontSize = 18;
        } else if (apCount > 12) {
          primaryFontSize = 21;
          secondaryFontSize = 17;
          tertiaryFontSize = 17;
        }
        
        // Aplicar escala base
        primaryFontSize = Math.round(primaryFontSize * baseScale);
        secondaryFontSize = Math.round(secondaryFontSize * baseScale);
        tertiaryFontSize = Math.round(tertiaryFontSize * baseScale);

        // Para predios pequeños (<=6 APs) reducir las fuentes "un poquito" para evitar congestión
        if (apCount <= 6) {
          primaryFontSize = Math.max(10, primaryFontSize - 1);
          secondaryFontSize = Math.max(10, secondaryFontSize - 1);
          tertiaryFontSize = Math.max(10, tertiaryFontSize - 1);
        }

        if (isExternal) {
          textAnchor = 'end';
          labelX = -28;
          primaryY = -8;
          secondaryY = primaryY + 16;
          tertiaryY = secondaryY + 16;
        }
        
        const { primary, secondary, tertiary } = computeNodeLabels(node);
        const showPrimary = !isExternal && Boolean(primary);
        const showSecondary = !isExternal && Boolean(secondary);
        const showTertiary = !isExternal && Boolean(tertiary);
        const titleParts = [primary, secondary, tertiary, node.status].filter(Boolean);

        return (
          <g key={node.id} transform={`translate(${node.x},${node.y})`}>
            <NodeShape node={node} fill={color} scaleFactor={iconScale} />
            {showPrimary && (
              <text
                x={labelX}
                y={primaryY}
                fontSize={primaryFontSize}
                fontWeight="500"
                fill="#1e293b"
                textAnchor={textAnchor}
              >
                {primary}
              </text>
            )}
            {showSecondary && (
              <text
                x={labelX}
                y={secondaryY}
                fontSize={secondaryFontSize}
                fontWeight="400"
                fill="#475569"
                textAnchor={textAnchor}
              >
                {secondary}
              </text>
            )}
            {showTertiary && (
              <text
                x={labelX}
                y={tertiaryY}
                fontSize={tertiaryFontSize}
                fontWeight="400"
                fill="#64748b"
                textAnchor={textAnchor}
              >
                {tertiary}
              </text>
            )}
            <title>{titleParts.length ? titleParts.join('\n') : node.status || 'unknown'}</title>
          </g>
        );
      })}
    </svg>
  );
}

function NodeShape({ node, fill, scaleFactor = 1.0 }) {
  const baseStroke = '#ecf0f1';
  
  // Aplicar factor de escala a todas las dimensiones
  const scale = (size) => Math.round(size * scaleFactor);
  
  if (node.kind === 'external') {
    const size = scale(20);
    const half = size / 2;
    return <rect x={-half} y={-half} width={size} height={size} transform="rotate(45)" fill="#fff" stroke={fill} strokeWidth={2.5} rx={2} ry={2} />;
  }
  if (node.kind === 'appliance' || node.kind === 'gateway') {
    return <rect x={-scale(20)} y={-scale(12)} width={scale(40)} height={scale(24)} rx={4} ry={4} fill={fill} stroke={baseStroke} strokeWidth={1.5} />;
  }
  if (node.kind === 'switch' || node.kind === 'bridge') {
    return <rect x={-scale(24)} y={-scale(14)} width={scale(48)} height={scale(28)} rx={5} ry={5} fill={fill} stroke={baseStroke} strokeWidth={1.5} />;
  }
  if (node.kind === 'camera') {
    return <rect x={-scale(16)} y={-scale(11)} width={scale(32)} height={scale(22)} rx={11} ry={11} fill={fill} stroke={baseStroke} strokeWidth={1.5} />;
  }
  if (node.kind === 'sensor') {
    const points = `0,${-scale(16)} ${scale(14)},0 0,${scale(16)} ${-scale(14)},0`;
    return <polygon points={points} fill={fill} stroke={baseStroke} strokeWidth={1.5} />;
  }
  return <circle r={scale(14)} fill={fill} stroke={baseStroke} strokeWidth={1.5} />;
}
