function classifyUrl(url, config, target) {
  try {
    const hostname = new URL(url).hostname;
    for (const domain of target.domains) {
      if (domain.startsWith('*.')) {
        const base = domain.slice(2);
        if (hostname === base || hostname.endsWith('.' + base)) return 'self';
      } else {
        if (hostname === domain) return 'self';
      }
    }
    for (const adDomain of config.adNetworks) {
      if (hostname === adDomain || hostname.endsWith('.' + adDomain)) return 'ad';
    }
    return 'thirdparty';
  } catch (e) { return 'thirdparty'; }
}

function normalizeUrl(url, classification, config) {
  try {
    const u = new URL(url);
    u.hash = '';
    const trackingParams = new Set(config.adTrackingParams || []);
    const params = new URLSearchParams(u.search);
    for (const key of [...params.keys()]) {
      if (trackingParams.has(key)) params.delete(key);
    }
    if (classification === 'ad') {
      for (const [key, value] of [...params.entries()]) {
        if (/^\d{8,}$/.test(value)) params.delete(key);
      }
    }
    params.sort();
    u.search = params.toString();
    return u.protocol + '//' + u.hostname.toLowerCase() + u.pathname + (u.search || '');
  } catch (e) { return url; }
}

module.exports = { classifyUrl, normalizeUrl };
