import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '');
  const backendPort = env.PORT || env.PULSE_PORT || '8085';

  return {
    plugins: [react()],
    base: '/dashboard/',
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${backendPort}`,
          changeOrigin: true
        },
        '/ws': {
          target: `ws://127.0.0.1:${backendPort}`,
          ws: true
        }
      }
    }
  };
});
