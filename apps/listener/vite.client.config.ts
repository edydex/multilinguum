import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    lib: { entry: 'src/heritage.tsx', formats: ['es'], fileName: () => 'heritage.js' },
    chunkSizeWarningLimit: 800,
    rollupOptions: { output: { chunkFileNames: '[name]-[hash].js' } },
  },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
});
