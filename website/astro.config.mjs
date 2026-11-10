import { defineConfig } from 'astro/config'

// GitHub Pages project site. On a custom domain, set `site` to it and drop `base`.
export default defineConfig({
  site: 'https://angelplusultra.github.io',
  base: '/oatmeal',
  // Compression drops the space in "text\n<code>", gluing words to inline elements.
  compressHTML: false,
  // Plain `localhost` binds only [::1] here, which T3 Code's port forwarding can't reach.
  server: { host: '127.0.0.1' },
  // The screenshots and icon are imported from the app's docs/ and assets/, not copied.
  vite: { server: { fs: { allow: ['..'] } } },
})
