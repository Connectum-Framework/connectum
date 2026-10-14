/**
 * Unit tests for auth context storage
 *
 * Tests getAuthContext() and requireAuthContext() behavior
 * with and without AsyncLocalStorage context.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import { assertConnectError } from "@connectum/testing";
import { authContextStorage, getAuthContext, requireAuthContext } from "../../src/context.ts";
import type { AuthContext } from "../../src/types.ts";

describe("context", () => {
    describe("getAuthContext()", () => {
        it("should return undefined outside storage", () => {
            const result = getAuthContext();
            assert.strictEqual(result, undefined);
        });

        it("should return context inside storage.run()", () => {
            const mockContext: AuthContext = {
                subject: "user-1",
                roles: ["admin"],
                scopes: ["read"],
                claims: {},
                type: "test",
            };

            authContextStorage.run(mockContext, () => {
                const result = getAuthContext();
                assert.ok(result);
                assert.strictEqual(result.subject, "user-1");
                assert.deepStrictEqual(result.roles, ["admin"]);
                assert.deepStrictEqual(result.scopes, ["read"]);
                assert.strictEqual(result.type, "test");
            });
        });
    });

    describe("requireAuthContext()", () => {
        it("should throw ConnectError(Unauthenticated) outside storage", () => {
            assert.throws(
                () => requireAuthContext(),
                (err: unknown) => {
                    assertConnectError(err, Code.Unauthenticated, /Authentication required/);
                    return true;
                },
            );
        });

        it("should return context inside storage.run()", () => {
            const mockContext: AuthContext = {
                subject: "user-42",
                roles: ["viewer"],
                scopes: ["read"],
                claims: { foo: "bar" },
                type: "jwt",
            };

            authContextStorage.run(mockContext, () => {
                const result = requireAuthContext();
                assert.strictEqual(result.subject, "user-42");
                assert.deepStrictEqual(result.roles, ["viewer"]);
                assert.deepStrictEqual(result.claims, { foo: "bar" });
                assert.strictEqual(result.type, "jwt");
            });
        });
    });
});

describe("globalThis singleton resilience", () => {
    // Новый экземпляр модуля: уникальная query-строка заставляет загрузчик вычислить
    // context.ts заново. Спецификатор собран из переменной, поэтому tsc не ищет файл с query.
    const contextModulePath = "../../src/context.ts";
    const loadContextModule = (instance: string): Promise<typeof import("../../src/context.ts")> => import(`${contextModulePath}?${instance}`);

    const STORAGE_KEY = Symbol.for("@connectum/auth/context-storage");
    const META_KEY = Symbol.for("@connectum/auth/context-storage-meta");

    it("should store authContextStorage in globalThis via Symbol.for key", () => {
        const stored = (globalThis as Record<symbol, unknown>)[STORAGE_KEY];
        assert.strictEqual(authContextStorage, stored,
            "authContextStorage should be the same instance as globalThis[STORAGE_KEY]");
    });

    it("should have meta with initUrl", () => {
        const meta = (globalThis as Record<symbol, unknown>)[META_KEY] as { initUrl: string; warned: boolean };
        assert.ok(meta, "meta should exist");
        assert.strictEqual(typeof meta.initUrl, "string");
        assert.strictEqual(typeof meta.warned, "boolean");
    });

    // Сценарий: один и тот же модуль вычислен дважды (например исходники и собранный
    // вывод в одном процессе). Query-строка в specifier заставляет Node создать
    // отдельный экземпляр модуля с собственным import.meta.url. Контекст, записанный
    // через первый экземпляр, обязан читаться вторым: иначе интерцептор из одного
    // экземпляра записал бы личность, а обработчик из другого её не увидел бы.
    // Поведение AsyncLocalStorage (контекст виден внутри run() и в его асинхронных
    // продолжениях) описано в документации Node.js, модуль async_hooks.
    it("should share auth context between two separately evaluated module instances", async () => {
        const mockContext: AuthContext = {
            subject: "dual-instance-test",
            roles: ["admin"],
            scopes: ["read"],
            claims: {},
            type: "jwt",
        };
        const g = globalThis as Record<symbol, unknown>;
        const meta = g[META_KEY] as { warned: boolean };
        const warnedBefore = meta.warned;
        // Предупреждение о втором экземпляре выдаётся один раз за процесс; сбрасываем
        // флаг, чтобы проверка не зависела от порядка тестов.
        meta.warned = false;

        const warningCodes: unknown[] = [];
        const onWarning = (w: Error): void => {
            warningCodes.push((w as Error & { code?: string }).code);
        };
        process.on("warning", onWarning);

        try {
            const second = await loadContextModule("second-instance");

            assert.strictEqual(second.authContextStorage, authContextStorage, "both instances must resolve to the same storage object");
            assert.notStrictEqual(second, await import("../../src/context.ts"), "the import must really produce a second module instance");

            await authContextStorage.run(mockContext, async () => {
                await Promise.resolve();
                const seenBySecond = second.getAuthContext();
                assert.ok(seenBySecond);
                assert.strictEqual(seenBySecond.subject, "dual-instance-test");
            });
            assert.strictEqual(second.getAuthContext(), undefined, "context must not leak outside run()");

            // process.emitWarning доставляет событие асинхронно.
            await new Promise((resolve) => setImmediate(resolve));
            assert.ok(
                warningCodes.includes("CONNECTUM_AUTH_DUP_INIT"),
                "a second module instance must be reported with CONNECTUM_AUTH_DUP_INIT",
            );
        } finally {
            process.off("warning", onWarning);
            meta.warned = warnedBefore;
        }
    });

    // Сценарий: под общим ключом лежит не AsyncLocalStorage (чужой код перезаписал
    // глобальный слот). Реальный код при вычислении модуля обязан отказать явной
    // ошибкой, а не молча работать с мусором. Вычисляется свежий экземпляр модуля,
    // чтобы пройти настоящую проверку, а не её копию в тесте.
    it("should reject a corrupted globalThis storage when the module is evaluated", async () => {
        const g = globalThis as Record<symbol, unknown>;
        const original = g[STORAGE_KEY];

        try {
            g[STORAGE_KEY] = "not-a-storage";
            await assert.rejects(
                loadContextModule("corrupted-storage"),
                /is not an AsyncLocalStorage instance/,
            );
        } finally {
            g[STORAGE_KEY] = original;
        }
    });

    // Частичная имитация (есть run и getStore, нет enterWith) тоже должна отвергаться:
    // проверка требует все три метода.
    it("should reject a storage lookalike that lacks enterWith", async () => {
        const g = globalThis as Record<symbol, unknown>;
        const original = g[STORAGE_KEY];

        try {
            g[STORAGE_KEY] = { run: () => undefined, getStore: () => undefined };
            await assert.rejects(
                loadContextModule("lookalike-storage"),
                /is not an AsyncLocalStorage instance/,
            );
        } finally {
            g[STORAGE_KEY] = original;
        }
    });
});
