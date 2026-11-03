import { defineConfig } from 'vite';

/**
 * The session recorder as one classic script, `public/replay/recorder.js`.
 *
 * Separate from the app build because it is loaded by other sites too
 * (lain-os.com, chaos.fm): a classic script runs from any origin, while the
 * app's ES modules would need CORS headers on every chunk they import.
 */
export default defineConfig({
    publicDir: false,
    build: {
        outDir: 'public/replay',
        emptyOutDir: true,
        copyPublicDir: false,
        sourcemap: false,
        target: 'es2019',
        lib: {
            entry: 'resources/js/replay/recorder.ts',
            name: 'cyberiaRecorder',
            formats: ['iife'],
            fileName: () => 'recorder.js',
        },
    },
});
