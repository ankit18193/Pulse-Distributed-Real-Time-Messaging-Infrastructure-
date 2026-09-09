#!/usr/bin/env node
/**
 * Pulse — Distributed Real-Time Messaging Infrastructure
 * Standalone Server CLI Entrypoint (pulse-server)
 *
 * Runs the Pulse server as a dedicated daemon process with signal traps
 * and production resilience boundaries.
 */

import { PulseServer } from '../core/PulseServer.js';
import { loadConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Pulse — Distributed Real-Time Messaging Infrastructure Server

Usage:
  pulse-server [options]
  npx @ankit18193/pulse [options]

Environment Variables:
  PORT                          HTTP/WebSocket port (default: 8080)
  HOST                          Network interface to bind (default: 0.0.0.0)
  NODE_ENV                      Environment ('development' | 'test' | 'production')
  AUTH_SECRET                   HMAC secret key for token authentication (min 32 chars in prod)
  REDIS_ENABLED                 Enable Redis cluster pub/sub ('true' | 'false')
  REDIS_URL                     Redis connection string (e.g. redis://127.0.0.1:6379)
  MAX_CONNECTIONS               Maximum concurrent active connections (default: 10000)
  MAX_ROOMS_PER_CONNECTION      Maximum rooms a connection may join (default: 100)
  ALLOWED_ORIGINS               Comma-separated allowed origins (default: '*' in dev)
  INBOUND_RATE_LIMIT_MAX        Rate limit tokens per second per socket (default: 100)
  INBOUND_RATE_LIMIT_BURST      Maximum burst tokens allowed per socket (default: 50)
  DRAIN_TIMEOUT_MS              Graceful shutdown draining timeout in ms (default: 2000)

Options:
  -h, --help                    Show this help message and exit
  -v, --version                 Show version and exit
`);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  console.log('0.3.0');
  process.exit(0);
}

async function bootstrap() {
  const config = loadConfig();
  const server = new PulseServer(config);

  const handleSignal = async (signal: string) => {
    logger.info(`Received ${signal}, initiating graceful shutdown...`);
    await server.stop();
    process.exit(0);
  };

  const handleFatal = async (type: string, error: unknown) => {
    logger.error(`Fatal ${type} encountered, executing emergency cleanup and terminating`, {
      type,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
    });
    try {
      const emergencyTimeout = setTimeout(() => {
        process.exit(1);
      }, 3000);
      if (typeof emergencyTimeout.unref === 'function') {
        emergencyTimeout.unref();
      }
      await server.stop({ gracePeriodMs: 1000 });
    } catch {
      // emergency exit
    } finally {
      process.exit(1);
    }
  };

  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('uncaughtException', (err) => handleFatal('uncaughtException', err));
  process.on('unhandledRejection', (reason) => handleFatal('unhandledRejection', reason));

  try {
    await server.start();
  } catch (err) {
    logger.error('Fatal error during Pulse server bootstrap', {
      error: err instanceof Error ? err.message : String(err)
    });
    process.exit(1);
  }
}

bootstrap();
