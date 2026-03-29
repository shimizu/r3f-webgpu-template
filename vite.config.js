import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1000,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react',
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 30,
            },
            {
              name: 'fiber',
              test: /node_modules[\\/]@react-three[\\/]fiber[\\/]/,
              priority: 25,
            },
            {
              name: 'drei',
              test: /node_modules[\\/]@react-three[\\/]drei[\\/]/,
              priority: 24,
            },
            {
              name: 'three-webgpu',
              test: /node_modules[\\/]three[\\/](src[\\/]renderers[\\/]webgpu|build[\\/]three\.webgpu)/,
              priority: 23,
            },
            {
              name: 'three-tsl',
              test: /node_modules[\\/]three[\\/](src[\\/]nodes|build[\\/]three\.tsl)/,
              priority: 22,
            },
            {
              name: 'three-core',
              test: /node_modules[\\/]three[\\/]/,
              priority: 20,
            },
            {
              name: 'vendor',
              test: /node_modules[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
})
