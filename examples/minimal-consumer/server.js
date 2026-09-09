import { PulseServer, Authenticator } from '@ankit18193/pulse';

const port = parseInt(process.env.PORT || '8888', 10);
const authSecret = process.env.AUTH_SECRET || 'pulse-dev-secret-key-32chars-min';

// Initialize Pulse Server using minimal configuration
const server = new PulseServer({
  port,
  authSecret,
  metricsEnabled: true
});

console.log(`Starting Pulse server on port ${port}...`);
await server.start();
console.log(`Pulse server active and listening on ws://localhost:${port}`);

// Generate a valid authentication token for demonstration
const authenticator = new Authenticator(authSecret);
const sampleToken = authenticator.generateToken({
  userId: 'alice',
  roles: ['member']
});

console.log(`\nSample auth token for user 'alice':`);
console.log(sampleToken);

const shutdown = async () => {
  console.log('\nGracefully shutting down Pulse server...');
  await server.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
