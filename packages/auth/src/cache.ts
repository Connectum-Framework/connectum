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
        // `Infinity` would keep a verified identity for ever and `NaN` makes every
        // expiry comparison false, so both are refused along with zero and negatives.
        if (typeof options.ttl !== "number" || !Number.isFinite(options.ttl) || options.ttl <= 0) {
            throw new RangeError(`ttl must be a positive number of milliseconds (finite, greater than 0), got ${String(options.ttl)}`);
        }
        const maxSize = options.maxSize ?? 1000;
        // Eviction runs when `size >= maxSize`: with a size below 1 the map is still empty
        // at that point so nothing is evicted, and `NaN`/`Infinity` never compare as full,
        // so all of them would leave the cache unbounded. A fractional size is a mistake too.
        if (typeof maxSize !== "number" || !Number.isInteger(maxSize) || maxSize < 1) {
            throw new RangeError(`maxSize must be an integer greater than or equal to 1, got ${String(maxSize)}`);
        }
        this.#ttl = options.ttl;
        this.#maxSize = maxSize;
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
