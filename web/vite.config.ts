import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  base: './',
  plugins: [preact()],
  build: {
    outDir: 'dist',
    target: 'es2020',
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
