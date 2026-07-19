/**
 * Minimal ambient type declarations for `tiged` (the maintained `degit` fork used
 * by the `connectum init` base fetcher). `tiged` ships JavaScript without bundled
 * `.d.ts`, so we declare only the tiny surface we use.
 */
declare module "tiged" {
    interface TigedOptions {
        cache?: boolean;
        force?: boolean;
        verbose?: boolean;
    }
    interface TigedEmitter {
        clone(dest: string): Promise<void>;
    }
    export default function tiged(src: string, opts?: TigedOptions): TigedEmitter;
}
