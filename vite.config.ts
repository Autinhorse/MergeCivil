import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  build: { modulePreload: false, rollupOptions: { input: { index: 'index.html', v9: 'v9.html' } } },
});
