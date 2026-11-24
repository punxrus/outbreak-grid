import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed dev port and no host-specific behaviour.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5180, strictPort: true },
  build: { target: 'es2022', sourcemap: true },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
