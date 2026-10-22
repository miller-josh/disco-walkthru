import { defineConfig } from 'vite';

// Relative base so the build works on GitHub Pages project sites, Netlify and Cloudflare Pages.
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1200 },
});
