import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/podcast': 'http://localhost:3000',
      '/media': 'http://localhost:3000',
    },
  },
});
