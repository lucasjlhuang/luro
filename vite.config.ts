import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed dev port; clearScreen off so rust errors stay visible.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'esnext',
    sourcemap: false,
    // Inline the cursor PNGs (~4KB each) so the bundle stays self-contained.
    assetsInlineLimit: 8192,
  },
});
