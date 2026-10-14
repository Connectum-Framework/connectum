/**
 * Unit tests for LRU cache with TTL
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { LruCache } from "../../src/cache.ts";

describe("LruCache", () => {
    it("should store and retrieve values", () => {
        const cache = new LruCache<string>({ ttl: 60_000 });
        cache.set("key1", "value1");
        assert.strictEqual(cache.get("key1"), "value1");
    });

    it("should return undefined for missing keys", () => {
        const cache = new LruCache<string>({ ttl: 60_000 });
        assert.strictEqual(cache.get("missing"), undefined);
    });

    it("should expire entries after TTL", () => {
        const originalNow = Date.now;
        let currentTime = 1000;
        Date.now = () => currentTime;

        try {
            const cache = new LruCache<string>({ ttl: 100 });
            cache.set("key1", "value1");

            // Still valid
            currentTime = 1050;
            assert.strictEqual(cache.get("key1"), "value1");

            // Expired
            currentTime = 1100;
            assert.strictEqual(cache.get("key1"), undefined);
        } finally {
            Date.now = originalNow;
        }
    });

    it("should evict LRU entry when maxSize is reached", () => {
        const cache = new LruCache<string>({ ttl: 60_000, maxSize: 2 });
        cache.set("key1", "value1");
        cache.set("key2", "value2");
        cache.set("key3", "value3"); // Should evict key1

        assert.strictEqual(cache.get("key1"), undefined);
        assert.strictEqual(cache.get("key2"), "value2");
        assert.strictEqual(cache.get("key3"), "value3");
    });

    it("should move accessed entry to end (most recently used)", () => {
        const cache = new LruCache<string>({ ttl: 60_000, maxSize: 2 });
        cache.set("key1", "value1");
        cache.set("key2", "value2");

        // Access key1, making it most recently used
        cache.get("key1");

        // Now adding key3 should evict key2 (LRU), not key1
        cache.set("key3", "value3");

        assert.strictEqual(cache.get("key1"), "value1");
        assert.strictEqual(cache.get("key2"), undefined);
        assert.strictEqual(cache.get("key3"), "value3");
    });

    it("should default maxSize to 1000", () => {
        const cache = new LruCache<string>({ ttl: 60_000 });
        // Fill exactly to the default capacity: nothing may be evicted yet.
        for (let i = 0; i < 1000; i++) {
            cache.set(`key${i}`, `value${i}`);
        }
        assert.strictEqual(cache.size, 1000);
        assert.strictEqual(cache.get("key0"), "value0");

        // One more entry evicts exactly the least recently used one.
        cache.set("key1000", "value1000");
        assert.strictEqual(cache.size, 1000);
        assert.strictEqual(cache.get("key1"), undefined);
        assert.strictEqual(cache.get("key1000"), "value1000");
        // key0 was read above, so it is more recent than key1 and survives.
        assert.strictEqual(cache.get("key0"), "value0");
    });

    it("should clear all entries", () => {
        const cache = new LruCache<string>({ ttl: 60_000 });
        cache.set("key1", "value1");
        cache.set("key2", "value2");
        assert.strictEqual(cache.size, 2);

        cache.clear();
        assert.strictEqual(cache.size, 0);
        assert.strictEqual(cache.get("key1"), undefined);
    });

    it("should update value and reset TTL on re-set", () => {
        const originalNow = Date.now;
        let currentTime = 1000;
        Date.now = () => currentTime;

        try {
            const cache = new LruCache<string>({ ttl: 100 });
            cache.set("key1", "value1");

            // Advance time near expiry
            currentTime = 1080;
            // Re-set resets TTL
            cache.set("key1", "updated");

            // Would have expired from original set, but re-set extends
            currentTime = 1150;
            assert.strictEqual(cache.get("key1"), "updated");

            // Now it expires from the re-set
            currentTime = 1180;
            assert.strictEqual(cache.get("key1"), undefined);
        } finally {
            Date.now = originalNow;
        }
    });
});
