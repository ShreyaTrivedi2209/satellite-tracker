import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api/iss': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
      '/api/satellites': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
      '/api/celestrak': {
        target: 'https://celestrak.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/celestrak/, '')
      }
    }
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        format: 'es'
      }
    }
  },
  worker: {
    format: 'es'
  }
});
