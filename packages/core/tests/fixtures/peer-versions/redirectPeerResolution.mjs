/**
 * Preload for a child process: redirects how `peerVersions.ts` resolves the peer
 * libraries (`import.meta.resolve` from that module) to a chosen fixture copy,
 * without touching how any other module resolves them. The real libraries therefore
 * keep loading normally and only the version check sees the "wrong" copy.
 *
 * `PEER_RESOLUTION_MAP` is a JSON object: library name -> entry file URL.
 */

import { registerHooks } from "node:module";

const redirects = JSON.parse(process.env.PEER_RESOLUTION_MAP ?? "{}");

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (Object.hasOwn(redirects, specifier) && context.parentURL?.endsWith("/src/peerVersions.ts")) {
            return { url: redirects[specifier], shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});
