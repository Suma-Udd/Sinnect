import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: { '@engine': path.resolve(__dirname, '../engine/src') },
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [path.resolve(__dirname, '..')] },
  },
  build: { target: 'es2022', outDir: 'dist', chunkSizeWarningLimit: 1500 },
});
