import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      workbox: {
        // Solo cachear assets estáticos, NO el HTML ni APIs
        globPatterns: ['**/*.{js,css,ico,png,svg,woff,woff2}'],
        // Excluir archivos que no deben cachearse
        globIgnores: ['**/index.html', '**/manifest.json', '**/sw.js'],
        cleanupOutdatedCaches: true,
        // CAMBIO CRÍTICO: No forzar activación inmediata para evitar inconsistencias
        skipWaiting: false,
        clientsClaim: false,
        // NO cachear APIs - siempre ir a la red para datos frescos
        // Eliminado runtimeCaching para APIs del backend
        runtimeCaching: [
          // Solo cachear API externa de Meraki con timeout muy corto
          {
            urlPattern: /^https:\/\/api\.meraki\.com\/.*/i,
            handler: 'NetworkOnly', // No cachear API de Meraki
            options: {
              cacheName: 'meraki-api-cache'
              // networkTimeoutSeconds removido - no compatible con NetworkOnly
            }
          }
          // ELIMINADO: Cache del backend - las APIs siempre deben ir a la red
        ],
        // Navegación siempre va a la red primero
        navigateFallback: null,
        navigateFallbackDenylist: [/^\/api\//]
      },
      includeAssets: ['icon-192.svg', 'icon-512.svg'],
      manifest: {
        name: 'Portal Meraki',
        short_name: 'Portal Meraki',
        description: 'Portal de monitoreo y diagnóstico de redes Cisco Meraki',
        theme_color: '#2563eb',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: 'icon-192.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          },
          {
            src: 'icon-512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          }
        ]
      },
      devOptions: {
        enabled: false
      }
    })
  ],
  server: {
    port: 5173,
    host: '0.0.0.0',  // Escuchar en todas las interfaces
    open: false,
    allowedHosts: [
      '.ngrok-free.dev',
      '.ngrok.io',
      'localhost'
    ],
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    minify: 'esbuild',
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom']
        }
      }
    }
  },
  preview: {
    port: 5173,
    host: '0.0.0.0'
  }
})
