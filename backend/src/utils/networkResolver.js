const { getNetworkInfo, getOrganizations, getNetworks } = require('../merakiApi');
const { getPredioInfoForNetwork } = require('../prediosManager');
const { cache, getFromCache, setInCache } = require('../cache/cacheStore');
const { logger } = require('../config/logger');

async function resolveNetworkOrgId(networkId) {
  try {
    const cachedNet = getFromCache(cache.networkById, networkId);
    if (cachedNet && cachedNet.organizationId) return cachedNet.organizationId;

    const predioInfo = getPredioInfoForNetwork(networkId);
    if (predioInfo && predioInfo.organization_id) return predioInfo.organization_id;

    const net = await getNetworkInfo(networkId);
    if (!getFromCache(cache.networkById, networkId)) {
      setInCache(cache.networkById, networkId, net);
    }
    if (net.organizationId) return net.organizationId;
  } catch (error) {
    logger.error(`Error resolviendo orgId para ${networkId} (fase 1): ${error.message}`);
  }

  try {
    const orgs = await getOrganizations();
    for (const org of orgs) {
      const cachedNets = getFromCache(cache.networksByOrg, org.id);
      const nets = cachedNets || await getNetworks(org.id);
      if (!cachedNets) setInCache(cache.networksByOrg, org.id, nets);
      if (nets.find((n) => n.id === networkId)) return org.id;
    }
  } catch (error) {
    logger.error(`Error resolviendo orgId para ${networkId} (fase 2): ${error.message}`);
  }

  return null;
}

module.exports = {
  resolveNetworkOrgId,
};
