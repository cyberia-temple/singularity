import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const here = (relative: string) =>
    fileURLToPath(new URL(relative, import.meta.url));
const resources = process.env.CYBERIA_DESKTOP_RESOURCES || here('./resources');

export default defineConfig({
    root: path.join(resources, 'desktop'),
    envDir: false,
    publicDir: false,
    base: '/',
    plugins: [tailwindcss(), vue()],
    resolve: {
        alias: { '@': path.join(resources, 'js'), buffer: 'buffer/' },
        dedupe: ['vue'],
    },
    define: { 'import.meta.env.VITE_DESKTOP_WALLET': JSON.stringify('true') },
    build: {
        outDir: here('../../frontend/desktop/wallet-dist'),
        emptyOutDir: true,
        sourcemap: false,
        target: 'es2022',
    },
});
