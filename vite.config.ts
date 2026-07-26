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
    // Big Sur (macOS 11) ships Safari 14, and WKWebView tracks Safari — so the
    // bundle must parse there. 'esnext' emitted syntax that older WebKit can
    // reject outright, which surfaces as a blank window rather than an error.
    target: 'safari14',
    sourcemap: false,
    // Inline the cursor PNGs (~4KB each) so the bundle stays self-contained.
    assetsInlineLimit: 8192,
  },
});
