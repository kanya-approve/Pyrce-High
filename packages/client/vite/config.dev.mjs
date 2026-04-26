import { defineConfig } from 'vite';

export default defineConfig({
    base: './',
    build: {
        rollupOptions: {
            output: {
                manualChunks(id) {
                    if (id.includes('node_modules/phaser')) return 'phaser';
                    return undefined;
                }
            }
        },
    },
    server: {
        port: 8080
    }
});
