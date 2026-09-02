import http from 'http';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';

export interface AuthResult {
  authenticated: boolean;
  userId?: string;
  roles?: string[];
  error?: string;
}

export interface TokenPayload {
  userId: string;
  roles?: string[];
  iat: number;
  exp: number;
}

export class Authenticator {
  private readonly secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }

  /**
   * Generates a signed Phase 1 HMAC-SHA256 authentication token.
   */
  public generateToken(options: {
    userId: string;
    roles?: string[];
    expiresInMs?: number;
  }): string {
    const iat = Date.now();
    const exp = iat + (options.expiresInMs ?? 3600 * 1000); // default 1 hour
    const payload: TokenPayload = {
      userId: options.userId,
      roles: options.roles ?? ['user'],
      iat,
      exp
    };

    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', this.secret)
      .update(encodedPayload)
      .digest('base64url');

    return `${encodedPayload}.${signature}`;
  }

  /**
   * Extracts authentication token from incoming HTTP upgrade request.
   */
  public extractToken(req: http.IncomingMessage): string | null {
    // 1. Check URL query parameters (?token=...)
    if (req.url) {
      try {
        const url = new URL(req.url, 'http://localhost');
        const tokenFromQuery = url.searchParams.get('token');
        if (tokenFromQuery) {
          return tokenFromQuery;
        }
      } catch {
        // Fall through on malformed URL
      }
    }

    // 2. Check Authorization header (Bearer <token>)
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7).trim();
    }

    // 3. Check Sec-WebSocket-Protocol header
    const protocolHeader = req.headers['sec-websocket-protocol'];
    if (protocolHeader) {
      const protocols = protocolHeader.split(',').map((p) => p.trim());
      // Look for a token parameter or bearer token
      for (const p of protocols) {
        if (p.startsWith('token.')) {
          return p.substring(6);
        }
      }
    }

    return null;
  }

  /**
   * Validates a signed token.
   */
  public verifyToken(token: string | null): AuthResult {
    if (!token) {
      return {
        authenticated: false,
        error: 'Missing authentication token'
      };
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
      return {
        authenticated: false,
        error: 'Malformed token structure'
      };
    }

    const [encodedPayload, providedSignature] = parts;

    // Verify signature
    const expectedSignature = crypto
      .createHmac('sha256', this.secret)
      .update(encodedPayload)
      .digest('base64url');

    // Constant-time comparison to prevent timing attacks
    const providedBuffer = Buffer.from(providedSignature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (
      providedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      return {
        authenticated: false,
        error: 'Invalid token signature'
      };
    }

    // Parse payload
    try {
      const payloadJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');
      const payload: TokenPayload = JSON.parse(payloadJson);

      if (!payload.userId || typeof payload.userId !== 'string') {
        return {
          authenticated: false,
          error: 'Token missing valid userId'
        };
      }

      // Check expiration
      if (Date.now() > payload.exp) {
        return {
          authenticated: false,
          error: 'Token has expired'
        };
      }

      return {
        authenticated: true,
        userId: payload.userId,
        roles: payload.roles ?? ['user']
      };
    } catch (err) {
      return {
        authenticated: false,
        error: 'Failed to decode token payload'
      };
    }
  }

  /**
   * Authenticates an incoming handshake request.
   */
  public authenticateRequest(req: http.IncomingMessage): AuthResult {
    const token = this.extractToken(req);
    const result = this.verifyToken(token);

    if (!result.authenticated) {
      logger.warn('Handshake authentication rejected', {
        component: 'Authenticator',
        event: 'AUTH_REJECTED',
        reason: result.error,
        remoteAddress: req.socket.remoteAddress
      });
    }

    return result;
  }
}
