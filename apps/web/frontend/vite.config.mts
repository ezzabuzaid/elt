import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    target: 'esnext',
    modulePreload: { polyfill: false },
  },
});
