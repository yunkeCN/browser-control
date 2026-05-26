import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@controller': path.resolve(__dirname, '../controller'),
      '@mcp': path.resolve(__dirname, '../mcp'),
    },
  },
  server: {
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 4173),
  },
  build: {
    outDir: 'dist',
  },
});
