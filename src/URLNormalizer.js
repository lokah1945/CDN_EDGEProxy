'use strict';

/**
 * URL normalization for canonical cache keys.
 * Goals:
 * - Same content under different tracking params → same key
 * - Signed URLs on known CDNs → stripped to base path
 * - Query params sorted for consistency
 */
class URLNormalizer {
  constructor() {
    // Tracking params to always strip
    this.trackingParams = new Set([
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'fbclid', 'gclid', 'gclsrc', 'yclid', 'msclkid', 'dclid',
      'spm', 'scm', '_ga', '_gl', 'mc_cid', 'mc_eid',
      'ncid', 'ref', 'ref_', 'referer', 'source',
      'ns_source', 'ns_mchannel', 'ns_campaign',
      'twclid', 'igshid', 'ttclid',
      'mibextid', 'hss_channel',
      '_branch_match_id', '_branch_referrer',
      'zanpid', 'irclickid', 'irgwc',
    ]);

    // Params to strip on known ad CDN domains
    this.adCdnStripParams = new Set([
      'cb', 'cachebuster', 'cache_buster', 'ord', 'correlator',
      'gdpr_consent', 'gdpr', 'us_privacy', 'gpp', 'gpp_sid',
      'usprivacy', 'addtl_consent', 'consent',
      'dt', 'timestamp', 'ts', 't', 'rnd', 'rand', 'random',
      'bust', 'buster', 'nc',
    ]);

    // For these domains, ignore query entirely (path-only key)
    this.pathOnlyDomains = [
      'tpc.googlesyndication.com',
      'pagead2.googlesyndication.com',
      'fonts.gstatic.com',
      'fonts.googleapis.com',
    ];
  }

  normalize(url, classification) {
    try {
      const u = new URL(url);
      const hostname = u.hostname.toLowerCase();
      const pathname = u.pathname;

      // Path-only domains
      if (this.pathOnlyDomains.some(d => hostname === d || hostname.endsWith('.' + d))) {
        return `${hostname}${pathname}`;
      }

      // Build cleaned params
      const params = new URLSearchParams(u.searchParams);
      const toDelete = [];

      for (const [key] of params) {
        const kl = key.toLowerCase();
        // Always strip tracking params
        if (this.trackingParams.has(kl)) { toDelete.push(key); continue; }
        // Strip ad cache-busters for ad classification
        if (classification === 'ad' && this.adCdnStripParams.has(kl)) { toDelete.push(key); continue; }
        // Strip long numeric values (likely timestamps/nonces) for ads
        if (classification === 'ad') {
          const val = params.get(key);
          if (val && /^\d{10,}$/.test(val)) { toDelete.push(key); continue; }
        }
      }

      for (const k of toDelete) params.delete(k);

      // Sort remaining params
      params.sort();
      const qs = params.toString();
      return qs ? `${hostname}${pathname}?${qs}` : `${hostname}${pathname}`;
    } catch {
      return url;
    }
  }
}

module.exports = { URLNormalizer };
