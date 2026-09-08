/**
 * OriginMatcher — Normalized Cross-Site WebSocket Hijacking (CSWSH) Defense
 * 
 * Validates incoming WebSocket upgrade Origin headers against configured allowed origins.
 * Supports exact domain matches, subdomain wildcard patterns (*.example.com), and global wildcard (*).
 */
export class OriginMatcher {
  /**
   * Normalizes an origin string by lowercasing, stripping trailing slashes,
   * and removing standard default HTTP(S) ports (:80, :443).
   */
  public static normalizeOrigin(origin: string): string {
    const trimmed = origin.trim().toLowerCase().replace(/\/+$/, '');
    try {
      const url = new URL(trimmed);
      const protocol = url.protocol; // e.g. 'http:' or 'https:'
      const hostname = url.hostname;
      const port = url.port;

      if ((protocol === 'http:' && port === '80') || (protocol === 'https:' && port === '443') || !port) {
        return `${protocol}//${hostname}`;
      }
      return `${protocol}//${hostname}:${port}`;
    } catch {
      return trimmed;
    }
  }

  /**
   * Checks whether the provided Origin header is permitted under the allowedOrigins whitelist.
   * 
   * Rules:
   * 1. If allowedOrigins is undefined, empty, or includes '*', all origins are allowed.
   * 2. Non-browser clients omitting the Origin header are permitted (RFC 6455 CSWSH applies to browsers).
   * 3. If an Origin header is provided, it must match at least one allowed origin (exact or wildcard).
   */
  public static isAllowed(originHeader: string | undefined, allowedOrigins?: string[]): boolean {
    if (!allowedOrigins || allowedOrigins.includes('*')) {
      return true;
    }

    // Non-browser client where Origin header is absent
    if (!originHeader || originHeader.trim() === '') {
      return true;
    }

    if (allowedOrigins.length === 0) {
      return false;
    }

    const normalizedHeader = OriginMatcher.normalizeOrigin(originHeader);

    for (const allowed of allowedOrigins) {
      if (allowed === '*') {
        return true;
      }

      const normalizedAllowed = OriginMatcher.normalizeOrigin(allowed);
      if (normalizedHeader === normalizedAllowed) {
        return true;
      }

      // Check subdomain wildcard pattern: e.g. https://*.domain.com
      if (normalizedAllowed.includes('://*.')) {
        const [protocol, domainPattern] = normalizedAllowed.split('://*.');
        if (normalizedHeader.startsWith(`${protocol}://`)) {
          const hostPart = normalizedHeader.slice(`${protocol}://`.length).split(':')[0];
          if (hostPart.endsWith(`.${domainPattern}`) && hostPart.length > domainPattern.length + 1) {
            return true;
          }
        }
      }
    }

    return false;
  }
}
