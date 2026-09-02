import http from 'http';
import { Authenticator } from '../../src/auth/Authenticator';

describe('Authenticator (Commit 2)', () => {
  const secret = 'test-secret-key-1234567890123456';
  const authenticator = new Authenticator(secret);

  it('generates and verifies valid tokens', () => {
    const token = authenticator.generateToken({
      userId: 'user_123',
      roles: ['admin', 'operator']
    });

    const result = authenticator.verifyToken(token);
    expect(result.authenticated).toBe(true);
    expect(result.userId).toBe('user_123');
    expect(result.roles).toEqual(['admin', 'operator']);
    expect(result.error).toBeUndefined();
  });

  it('rejects expired tokens', () => {
    const expiredToken = authenticator.generateToken({
      userId: 'user_123',
      expiresInMs: -1000 // already expired
    });

    const result = authenticator.verifyToken(expiredToken);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Token has expired');
  });

  it('rejects tokens signed with a different secret', () => {
    const foreignAuth = new Authenticator('foreign-secret-key-abcdef');
    const foreignToken = foreignAuth.generateToken({ userId: 'user_123' });

    const result = authenticator.verifyToken(foreignToken);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBe('Invalid token signature');
  });

  it('rejects malformed tokens', () => {
    expect(authenticator.verifyToken(null).authenticated).toBe(false);
    expect(authenticator.verifyToken('').authenticated).toBe(false);
    expect(authenticator.verifyToken('not.a.valid.token').authenticated).toBe(false);
    expect(authenticator.verifyToken('invalid_base64.signature').authenticated).toBe(false);
  });

  it('extracts token from query parameters', () => {
    const req = { url: '/ws?token=sample_token_xyz' } as http.IncomingMessage;
    expect(authenticator.extractToken(req)).toBe('sample_token_xyz');
  });

  it('extracts token from Authorization header', () => {
    const req = {
      url: '/ws',
      headers: { authorization: 'Bearer bearer_token_abc' }
    } as unknown as http.IncomingMessage;
    expect(authenticator.extractToken(req)).toBe('bearer_token_abc');
  });

  it('extracts token from Sec-WebSocket-Protocol header', () => {
    const req = {
      url: '/ws',
      headers: { 'sec-websocket-protocol': 'json, token.proto_token_123' }
    } as unknown as http.IncomingMessage;
    expect(authenticator.extractToken(req)).toBe('proto_token_123');
  });
});
