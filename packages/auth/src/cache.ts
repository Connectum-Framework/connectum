/**
 * Minimal in-memory LRU cache with TTL expiration.
 *
 * Uses Map insertion order for LRU eviction.
 * No external dependencies.
 */

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

export class LruCache<T> {
    readonly #maxSize: number;
    readonly #ttl: number;
    readonly #entries = new Map<string, CacheEntry<T>>();

    constructor(options: { ttl: number; maxSize?: number | undefined }) {
        if (typeof options.ttl !== "number" || options.ttl <= 0) {
            throw new RangeError("ttl must be a positive number");
        }
        this.#ttl = options.ttl;
        this.#maxSize = options.maxSize ?? 1000;
    }

    get(key: string): T | undefined {
        const entry = this.#entries.get(key);
        if (!entry) return undefined;

        if (Date.now() >= entry.expiresAt) {
            this.#entries.delete(key);
            return undefined;
        }

        // Move to end (most recently used)
        this.#entries.delete(key);
        this.#entries.set(key, entry);
        return entry.value;
    }

    set(key: string, value: T): void {
        // Delete first to update insertion order
        this.#entries.delete(key);

        // Evict LRU (first entry) if at capacity
        if (this.#entries.size >= this.#maxSize) {
            const firstKey = this.#entries.keys().next().value;
            if (firstKey !== undefined) {
                this.#entries.delete(firstKey);
            }
        }

        this.#entries.set(key, {
            value,
            expiresAt: Date.now() + this.#ttl,
        });
    }

    clear(): void {
        this.#entries.clear();
    }

    get size(): number {
        return this.#entries.size;
    }
}
