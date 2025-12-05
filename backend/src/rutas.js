// Definición de rutas principales de la API
// 
// ARQUITECTURA ACTUAL:
// - Rutas de Meraki (topología, organizaciones, networks, etc) definidas inline en este archivo
// - Rutas modulares separadas en backend/src/routes/ (admin, auth, predios, networks, organizations, debug)
// - Actualmente solo admin.routes está montado aquí (para gestión de técnicos)
// - Las rutas REST legacy se mantienen aquí para compatibilidad (no reorganizar sin testing profundo)
//
const express = require('express');
const router = express.Router();

// Importar middleware y dependencias
const jwt = require('jsonwebtoken');

// Logger centralizado
const { logger } = require('./config/logger');

// Cliente centralizado de Meraki API (con rate limiting y retry)
const merakiApi = require('./merakiApi');

// Importar rutas modulares
const adminRoutes = require('./routes/admin.routes');

// Middleware para verificar el token JWT
function verificarToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ mensaje: 'Token no proporcionado' });
  jwt.verify(token, process.env.JWT_SECRETO, (err, usuario) => {
    if (err) return res.status(403).json({ mensaje: 'Token inválido' });
    req.usuario = usuario;
    next();
  });
}

// Ruta para obtener la topología de un predio buscando la organización
router.get('/meraki/topologia-predio/:id_predio', verificarToken, async (req, res) => {
  const idPredio = req.params.id_predio;
  // Log para depuración: mostrar el valor recibido
  logger.debug(`Valor recibido en id_predio: '${idPredio}' (tipo: ${typeof idPredio})`);
  try {
    // 1. Obtener todas las organizaciones (usando cliente centralizado)
    const orgsData = await merakiApi.getOrganizations();
    // 2. Buscar en cada organización la network con el id solicitado
    for (const org of orgsData) {
      const networksData = await merakiApi.getNetworks(org.id);
      // Log para depuración avanzada: mostrar id_predio y todos los network.id
      logger.debug(`Organización: ${org.name} (${org.id}) - Networks:`);
      networksData.forEach(n => {
        const idPredioStr = String(idPredio).trim();
        const networkIdStr = String(n.id).trim();
        const comparacion = idPredioStr === networkIdStr;
        logger.debug(`  Network: ${n.name} - ID: '${networkIdStr}' (tipo: ${typeof n.id}) | id_predio: '${idPredioStr}' | Coincide: ${comparacion}`);
      });
      // Buscar por ID o por nombre de network
      const idPredioStr = String(idPredio).trim();
      let network = networksData.find(n => String(n.id).trim() === idPredioStr);
      if (!network) {
        network = networksData.find(n => n.name && n.name.trim().toLowerCase() === idPredioStr.toLowerCase());
        if (network) {
          logger.debug(`Predio encontrado por nombre: ${network.name} - ID: ${network.id}`);
        }
      }
      if (network) {
        logger.debug(`Predio encontrado: ${network.name} - ID: ${network.id} - Tipo: ${network.type || 'desconocido'}`);
        // 3. Consultar la topología de la network (usando cliente centralizado)
        try {
          const topologiaData = await merakiApi.getNetworkTopology(network.id);
          logger.debug('Topología recibida:', { data: JSON.stringify(topologiaData) });
          return res.json(topologiaData);
        } catch (errTopologia) {
          if (errTopologia.response) {
            logger.error('Error Meraki Topología:', {
              status: errTopologia.response.status,
              data: errTopologia.response.data
            });
            return res.status(500).json({ mensaje: 'Error Meraki Topología', status: errTopologia.response.status, data: errTopologia.response.data });
          } else {
            logger.error('Error Meraki Topología (sin respuesta):', { error: errTopologia.message });
            return res.status(500).json({ mensaje: 'Error Meraki Topología', error: errTopologia.message });
          }
        }
      }
    }
    logger.debug('Predio no encontrado en ninguna organización');
    res.status(404).json({ mensaje: 'Predio no encontrado en ninguna organización' });
  } catch (error) {
    logger.error('Error al consultar topología:', { error: error.message });
    res.status(500).json({ mensaje: 'Error al consultar topología', error: error.message });
  }
});

// Ruta para obtener organizaciones desde Meraki
router.get('/meraki/organizaciones', verificarToken, async (req, res) => {
  try {
    const data = await merakiApi.getOrganizations();
    res.json(data);
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al consultar Meraki', error: error.message });
  }
});

// Ruta para obtener la topología de un predio específico
router.get('/meraki/topologia/:id_predio', verificarToken, async (req, res) => {
  const idPredio = req.params.id_predio;
  try {
    const data = await merakiApi.getNetworkTopology(idPredio);
    res.json(data);
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al consultar topología', error: error.message });
  }
});

// Ruta de prueba
router.get('/prueba', (req, res) => {
  res.json({ mensaje: 'Ruta de prueba funcionando' });
});

// Login endpoint implementation is in servidor.js as POST /api/login

// Aquí se agregarán más rutas para usuarios, Meraki, etc.

// Wireless Controllers by Device de una organización
router.get('/meraki/org-wireless-controllers-by-device/:org_id', verificarToken, async (req, res) => {
  const orgId = req.params.org_id;
  try {
    const data = await merakiApi.getOrgWirelessControllersByDevice(orgId);
    res.json(data);
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al consultar wireless controllers by device', error: error.message });
  }
});

// Wireless Controller Connections de una organización
router.get('/meraki/org-wireless-connections/:org_id', verificarToken, async (req, res) => {
  const orgId = req.params.org_id;
  try {
    const data = await merakiApi.getOrgWirelessControllerConnections(orgId);
    res.json(data);
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al consultar wireless controller connections', error: error.message });
  }
});

// Access Points de una network
router.get('/meraki/network-access-points/:network_id', verificarToken, async (req, res) => {
  const networkId = req.params.network_id;
  try {
    const devices = await merakiApi.getNetworkDevices(networkId);
    // Filtrar solo access points (modelos que empiezan con MR)
    const aps = devices.filter(d => d.model && d.model.startsWith('MR'));
    res.json(aps);
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al consultar access points', error: error.message });
  }
});

// Switches de una network
router.get('/meraki/network-switches/:network_id', verificarToken, async (req, res) => {
  const networkId = req.params.network_id;
  try {
    const devices = await merakiApi.getNetworkDevices(networkId);
    // Filtrar solo switches (modelos que empiezan con MS)
    const switches = devices.filter(d => d.model && d.model.startsWith('MS'));
    res.json(switches);
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al consultar switches', error: error.message });
  }
});

// Appliance status de una network
router.get('/meraki/network-appliance-status/:network_id', verificarToken, async (req, res) => {
  const networkId = req.params.network_id;
  try {
    // Buscar el primer appliance (modelo que empieza con MX)
    const devices = await merakiApi.getNetworkDevices(networkId);
    const appliance = devices.find(d => d.model && d.model.startsWith('MX'));
    if (!appliance) {
      return res.status(404).json({ mensaje: 'No se encontró appliance (MX) en la network' });
    }
    // Obtener status del appliance
    const status = await merakiApi.getDeviceUplink(appliance.serial);
    res.json({ appliance, uplink: status });
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al consultar appliance status', error: error.message });
  }
});

// Ruta para listar todas las networks de todas las organizaciones
router.get('/meraki/all-networks', verificarToken, async (req, res) => {
  try {
    const orgsData = await merakiApi.getOrganizations();
    let allNetworks = [];
    for (const org of orgsData) {
      const networksData = await merakiApi.getNetworks(org.id);
      networksData.forEach(n => {
        let tipo = 'desconocido';
        if (Array.isArray(n.productTypes) && n.productTypes.length > 0) {
          tipo = n.productTypes.join(', ');
        } else if (n.type) {
          tipo = n.type;
        }
        allNetworks.push({
          orgName: org.name,
          orgId: org.id,
          name: n.name,
          id: n.id,
          type: tipo
        });
      });
    }
    res.json(allNetworks);
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al consultar todas las networks', error: error.message });
  }
});

// Ruta para consultar los detalles de una network
router.get('/meraki/network-info/:network_id', verificarToken, async (req, res) => {
  const networkId = req.params.network_id;
  logger.debug('Consultando info para networkId:', networkId);
  try {
    const data = await merakiApi.getNetworkInfo(networkId);
    let tipo = 'desconocido';
    if (Array.isArray(data.productTypes) && data.productTypes.length > 0) {
      tipo = data.productTypes.join(', ');
    } else if (data.type) {
      tipo = data.type;
    }
    res.json({
      ...data,
      type: tipo
    });
  } catch (error) {
    logger.error('Error Meraki network-info:', { data: error.response?.data || error.message });
    res.status(500).json({ mensaje: 'Error al consultar info de la network', error: error.message, meraki: error.response?.data });
  }
});

// Ruta para consultar los dispositivos de una network
router.get('/meraki/network-devices/:network_id', verificarToken, async (req, res) => {
  const networkId = req.params.network_id;
  logger.debug('Consultando dispositivos para networkId:', networkId);
  try {
    const data = await merakiApi.getNetworkDevices(networkId);
    res.json(data);
  } catch (error) {
    logger.error('Error Meraki network-devices:', { data: error.response?.data || error.message });
    res.status(500).json({ mensaje: 'Error al consultar dispositivos de la network', error: error.message, meraki: error.response?.data });
  }
});

// Ruta para consultar las organizaciones y permisos de la API key
router.get('/meraki/api-key-info', verificarToken, async (req, res) => {
  try {
    const data = await merakiApi.getOrganizations();
    res.json({ organizaciones: data });
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al consultar organizaciones con la API key', error: error.message });
  }
});

// Ruta para listar todas las networks de una organización (nombre, ID y tipo)
router.get('/meraki/networks/:org_id', verificarToken, async (req, res) => {
  const orgId = req.params.org_id;
  try {
    const networksData = await merakiApi.getNetworks(orgId);
    // Mostrar nombre, id y tipo usando productTypes si existe
    const listado = networksData.map(n => {
      let tipo = 'desconocido';
      if (Array.isArray(n.productTypes) && n.productTypes.length > 0) {
        tipo = n.productTypes.join(', ');
      } else if (n.type) {
        tipo = n.type;
      }
      return {
        name: n.name,
        id: n.id,
        type: tipo
      };
    });
    res.json(listado);
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al consultar networks', error: error.message });
  }
});
// Nuevo endpoint: información de network + topología
router.get('/meraki/network-topology/:network_id', verificarToken, async (req, res) => {
  const networkId = req.params.network_id;
  try {
    // Obtener info de la network (usando cliente centralizado)
    const infoData = await merakiApi.getNetworkInfo(networkId);
    let tipo = 'desconocido';
    if (Array.isArray(infoData.productTypes) && infoData.productTypes.length > 0) {
      tipo = infoData.productTypes.join(', ');
    } else if (infoData.type) {
      tipo = infoData.type;
    }
    // Obtener topología L2 (usando cliente centralizado)
    let topologiaL2 = null;
    try {
      topologiaL2 = await merakiApi.getNetworkTopologyLinkLayer(networkId);
    } catch (errTopo) {
      topologiaL2 = { error: errTopo.response?.data || errTopo.message };
    }
    // Obtener topología L3 (usando cliente centralizado)
    let topologiaL3 = null;
    try {
      topologiaL3 = await merakiApi.getNetworkTopologyNetworkLayer(networkId);
    } catch (errTopoL3) {
      topologiaL3 = { error: errTopoL3.response?.data || errTopoL3.message };
    }
    res.json({
      orgName: infoData.organizationName || '',
      orgId: infoData.organizationId || '',
      name: infoData.name,
      id: infoData.id,
      type: tipo,
      topologyL2: topologiaL2,
      topologyL3: topologiaL3
    });
  } catch (error) {
    res.status(500).json({ mensaje: 'Error al consultar network/topología', error: error.message });
  }
});

// Mount admin routes for technician management
router.use(adminRoutes);

module.exports = router;
