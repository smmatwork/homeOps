import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import svgr from "vite-plugin-svgr";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss(), svgr()],
  
  // Path aliases for cleaner imports
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@/components": path.resolve(__dirname, "./src/app/components"),
      "@/services": path.resolve(__dirname, "./src/app/services"),
      "@/hooks": path.resolve(__dirname, "./src/app/hooks"),
      "@/stores": path.resolve(__dirname, "./src/app/stores"),
      "@/styles": path.resolve(__dirname, "./src/app/styles"),
      "@/utils": path.resolve(__dirname, "./src/app/utils"),
    },
  },
  
  build: {
    // Reduce chunk size warning limit for better performance monitoring
    chunkSizeWarningLimit: 500,
    
    // Enable source maps for production debugging
    sourcemap: true,
    
    rollupOptions: {
      output: {
        // Optimized manual chunks for better caching
        manualChunks: {
          // Core React ecosystem
          react: ["react", "react-dom"],
          "react-router": ["react-router"],
          
          // UI Libraries (consider consolidating these)
          mui: ["@mui/material", "@mui/icons-material", "@emotion/react", "@emotion/styled"],
          radix: [
            "@radix-ui/react-accordion",
            "@radix-ui/react-alert-dialog",
            "@radix-ui/react-avatar",
            "@radix-ui/react-checkbox",
            "@radix-ui/react-collapsible",
            "@radix-ui/react-dialog",
            "@radix-ui/react-label",
            "@radix-ui/react-menubar",
            "@radix-ui/react-popover",
            "@radix-ui/react-separator",
            "@radix-ui/react-slider",
            "@radix-ui/react-slot",
            "@radix-ui/react-switch",
            "@radix-ui/react-toggle",
            "@radix-ui/react-tooltip",
          ],
          
          // Backend services
          supabase: ["@supabase/supabase-js"],
          
          // Data visualization
          charts: ["recharts"],
          
          // Utilities
          utils: ["class-variance-authority", "tailwind-merge", "zustand"],
        },
        
        // Optimize chunk naming for better caching
        chunkFileNames: (chunkInfo) => {
          const facadeModuleId = chunkInfo.facadeModuleId
            ? chunkInfo.facadeModuleId.split('/').pop()?.replace(/\.[^/.]+$/, '')
            : 'chunk';
          return `js/${facadeModuleId}-[hash].js`;
        },
        assetFileNames: (assetInfo) => {
          const info = assetInfo.name?.split('.') || [];
          const ext = info[info.length - 1];
          if (/png|jpe?g|svg|gif|tiff|bmp|ico/i.test(ext || '')) {
            return `img/[name]-[hash][extname]`;
          }
          if (/css/i.test(ext || '')) {
            return `css/[name]-[hash][extname]`;
          }
          return `assets/[name]-[hash][extname]`;
        },
      },
    },
    
    // Enable minification optimizations
    minify: true,
  },
  
  // Development server optimizations
  server: {
    hmr: {
      overlay: false,
    },
  },
  
  // Optimize dependencies
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-router',
      '@mui/material',
      '@supabase/supabase-js',
    ],
  },
});
