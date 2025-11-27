const cache = {
  networksByOrg: new Map(),
  networkById: new Map(),
  devicesStatuses: new Map(),
  applianceStatus: new Map(),
  topology: new Map(),
  switchPorts: new Map(),
  accessPoints: new Map(),
  lldpByNetwork: new Map(),
  TTL: {
    networks: 10 * 60 * 1000,
    devices: 3 * 60 * 1000,
    appliance: 1 * 60 * 1000,
    topology: 5 * 60 * 1000,
    lldp: Number(process.env.LLDP_CACHE_TTL_MS) || 10 * 60 * 1000,
    ports: 2 * 60 * 1000,
  },
};

function now() {
  return Date.now();
}

function getFromCache(map, key, category = 'networks') {
  if (!map || !key) return undefined;
  const hit = map.get(key);
  if (!hit) return undefined;
  const ttl = cache.TTL[category] || cache.TTL.networks;
  if (hit.exp < now()) {
    map.delete(key);
    return undefined;
  }
  return hit.data;
}

function setInCache(map, key, data, category = 'networks') {
  if (!map || !key) return;
  const ttl = cache.TTL[category] || cache.TTL.networks;
  map.set(key, { data, exp: now() + ttl });
}

module.exports = {
  cache,
  getFromCache,
  setInCache,
};
