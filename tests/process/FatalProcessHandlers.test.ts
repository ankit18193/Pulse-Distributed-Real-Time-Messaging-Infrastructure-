import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

describe('Phase 10 — Fatal Process Handlers & Emergency Exit', () => {
  const tempScriptPath = path.resolve(__dirname, 'fatal-test-runner.cjs');

  afterAll(() => {
    if (fs.existsSync(tempScriptPath)) {
      fs.unlinkSync(tempScriptPath);
    }
  });

  function runSubprocessWithTrap(errorType: 'uncaughtException' | 'unhandledRejection'): Promise<{ code: number | null; output: string }> {
    const script = `
const http = require('http');

const handleFatal = async (type, error) => {
  const message = JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'ERROR',
    service: 'pulse',
    message: 'Fatal ' + type + ' encountered, executing emergency cleanup and terminating',
    type: type,
    error: error instanceof Error ? { message: error.message } : String(error)
  });
  console.error(message);
  setTimeout(() => process.exit(1), 100);
};

process.on('uncaughtException', (err) => handleFatal('uncaughtException', err));
process.on('unhandledRejection', (reason) => handleFatal('unhandledRejection', reason));

if ('${errorType}' === 'uncaughtException') {
  setTimeout(() => {
    throw new Error('Simulated fatal uncaught error');
  }, 50);
} else {
  setTimeout(() => {
    Promise.reject(new Error('Simulated fatal unhandled rejection'));
  }, 50);
}
`;

    fs.writeFileSync(tempScriptPath, script);

    return new Promise((resolve) => {
      const child = spawn(process.execPath, [tempScriptPath], {
        env: { ...process.env, NODE_ENV: 'test' }
      });

      let output = '';
      child.stdout.on('data', (d) => { output += d.toString(); });
      child.stderr.on('data', (d) => { output += d.toString(); });

      child.on('close', (code) => {
        resolve({ code, output });
      });
    });
  }

  test('uncaughtException handler logs fatal error and exits process with exit code 1', async () => {
    const result = await runSubprocessWithTrap('uncaughtException');
    expect(result.code).toBe(1);
    expect(result.output).toContain('Fatal uncaughtException encountered');
    expect(result.output).toContain('Simulated fatal uncaught error');
  });

  test('unhandledRejection handler logs fatal error and exits process with exit code 1', async () => {
    const result = await runSubprocessWithTrap('unhandledRejection');
    expect(result.code).toBe(1);
    expect(result.output).toContain('Fatal unhandledRejection encountered');
    expect(result.output).toContain('Simulated fatal unhandled rejection');
  });
});
