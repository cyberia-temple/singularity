import { statSync } from 'node:fs';
import { registerHooks } from 'node:module';

/**
 * Teaches `node --test` the `@/` alias Vite and tsconfig already resolve, so
 * frontend modules can be imported here exactly as the app imports them
 * instead of keeping a second, relative import style just for tests.
 */

const ROOT = new URL('../../resources/js/', import.meta.url);

const CANDIDATES = ['.ts', '.mts', '.js', '/index.ts', '/index.js', ''];

const isFile = (url) => {
    try {
        return statSync(url).isFile();
    } catch {
        return false;
    }
};

registerHooks({
    resolve(specifier, context, nextResolve) {
        const alias = specifier.startsWith('@/');
        const localModule =
            specifier.startsWith('.') &&
            context.parentURL?.startsWith(ROOT.href);

        if (!alias && !localModule) {
            return nextResolve(specifier, context);
        }

        const base = alias
            ? new URL(specifier.slice(2), ROOT)
            : new URL(specifier, context.parentURL);

        for (const suffix of CANDIDATES) {
            const candidate = new URL(base.href + suffix);

            if (isFile(candidate)) {
                return { url: candidate.href, shortCircuit: true };
            }
        }

        return nextResolve(specifier, context);
    },
});
