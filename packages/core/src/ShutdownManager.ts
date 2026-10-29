/**
 * Instance-based shutdown manager with dependency ordering.
 *
 * Clean instance-based class for use within Server instances.
 *
 * Key characteristics:
 * - Does NOT manage process signals (Server handles that)
 * - Does NOT use global state (each Server gets its own instance)
 * - Is run once per server shutdown: the class is internal and `Server.stop()` is idempotent
 *
 * @module ShutdownManager
 */

/**
 * Shutdown hook function type
 *
 * A function called during graceful shutdown. May be synchronous or async.
 */
export type ShutdownHook = () => void | Promise<void>;

/** Short, unambiguous rendering of a rejected argument for an error message. */
function describeValue(value: unknown): string {
    if (typeof value === "string") {
        return `the string ${JSON.stringify(value)}`;
    }
    if (value === null) {
        return "null";
    }
    if (Array.isArray(value)) {
        return "an array";
    }
    return value === undefined ? "undefined" : `${typeof value} ${String(value)}`;
}

/**
 * Instance-based manager for shutdown hooks with dependency ordering.
 *
 * Handles graceful shutdown of application modules with support for:
 * - Dependency-ordered shutdown (dependencies execute first)
 * - Multiple handlers per named module
 * - Cycle detection in dependency graph
 * - Best-effort hook failures: every hook runs and is awaited whatever the
 *   others do, and `executeAll()` then reports all failures
 *   (see {@link ShutdownManager.executeAll})
 *
 * @example
 * ```typescript
 * const manager = new ShutdownManager();
 *
 * // Anonymous hook
 * manager.addHook(() => console.log('cleanup'));
 *
 * // Named hook
 * manager.addHook('database', async () => {
 *   await db.close();
 * });
 *
 * // Named hook with dependencies (dependencies execute first)
 * manager.addHook('server', ['database'], async () => {
 *   await server.close();
 * });
 *
 * // Execute all hooks in dependency order
 * await manager.executeAll();
 * ```
 */
export class ShutdownManager {
    /** Dependency graph: module name -> array of dependency names */
    private _dependencyTree = new Map<string, string[]>();

    /** Registered hooks: module name -> array of hook functions */
    private _hooks = new Map<string, ShutdownHook[]>();

    /** Pending execution promises (for deduplication during a single executeAll run) */
    private _pendingPromises = new Map<string, Promise<void>>();

    /** Failures of the current `executeAll` run: module name -> its failed handlers' errors */
    private _failures = new Map<string, unknown[]>();

    /** Counter for generating anonymous hook names */
    private _anonCounter = 0;

    /**
     * Register an anonymous shutdown hook (no dependencies)
     *
     * @param handler - Shutdown hook function
     */
    addHook(handler: ShutdownHook): void;

    /**
     * Register a named shutdown hook (no dependencies)
     *
     * @param name - Module name for identification and dependency resolution
     * @param handler - Shutdown hook function
     */
    addHook(name: string, handler: ShutdownHook): void;

    /**
     * Register a named shutdown hook with dependencies
     *
     * Dependencies are executed before this hook. If module "server" depends
     * on "database", then "database" hooks run first during shutdown.
     *
     * @param name - Module name for identification and dependency resolution
     * @param dependencies - Array of module names that must shut down first
     * @param handler - Shutdown hook function
     *
     * @throws {Error} If adding this hook would create a dependency cycle
     */
    addHook(name: string, dependencies: string[], handler: ShutdownHook): void;

    /**
     * Implementation of overloaded addHook method.
     *
     * Parses the overloaded parameters and registers the hook with
     * optional name and dependencies.
     *
     * @param nameOrHandler - Module name or handler function (for anonymous hooks)
     * @param depsOrHandler - Dependencies array or handler function
     * @param handlerArg - Handler function (when name and deps are provided)
     */
    addHook(nameOrHandler: string | ShutdownHook, depsOrHandler?: string[] | ShutdownHook, handlerArg?: ShutdownHook): void {
        let name: string;
        let dependencies: string[];
        let handler: ShutdownHook;

        if (typeof nameOrHandler === "function") {
            // addHook(handler)
            handler = nameOrHandler;
            dependencies = [];
            name = `__anon_${this._anonCounter++}`;
        } else if (typeof nameOrHandler !== "string") {
            throw new TypeError(`onShutdown(): the first argument must be a hook function or a module name (string), got ${describeValue(nameOrHandler)}`);
        } else if (typeof depsOrHandler === "function") {
            // addHook(name, handler)
            name = nameOrHandler;
            handler = depsOrHandler;
            dependencies = [];
        } else {
            // addHook(name, dependencies, handler)
            if (depsOrHandler === undefined) {
                throw new TypeError(`onShutdown("${nameOrHandler}"): expected a hook function, or an array of dependencies and a hook function, after the module name`);
            }
            // A string is iterable: spread into the dependency list it would become one
            // dependency per character and the intended order would silently be lost.
            if (!Array.isArray(depsOrHandler)) {
                throw new TypeError(`onShutdown("${nameOrHandler}"): dependencies must be an array of module names, got ${describeValue(depsOrHandler)}`);
            }
            const badIndex = depsOrHandler.findIndex((dependency) => typeof dependency !== "string");
            if (badIndex !== -1) {
                throw new TypeError(`onShutdown("${nameOrHandler}"): dependencies[${badIndex}] must be a module name (string), got ${describeValue(depsOrHandler[badIndex])}`);
            }
            if (typeof handlerArg !== "function") {
                throw new TypeError(`onShutdown("${nameOrHandler}"): the hook must be a function, got ${describeValue(handlerArg)}`);
            }
            name = nameOrHandler;
            dependencies = depsOrHandler;
            handler = handlerArg;
        }

        // Temporarily add dependencies to test for cycles
        const existing = this._dependencyTree.get(name) || [];
        const merged = [...existing, ...dependencies];
        this._dependencyTree.set(name, merged);

        if (this._testForCycles(name)) {
            // Rollback: restore previous dependencies
            this._dependencyTree.set(name, existing);
            throw new Error(`Adding shutdown handler "${name}" would create a dependency cycle`);
        }

        // Register handler
        if (!this._hooks.has(name)) {
            this._hooks.set(name, []);
        }
        this._hooks.get(name)?.push(handler);
    }

    /**
     * Execute all registered shutdown hooks in dependency order.
     *
     * Dependencies are executed before their dependents. Hooks within
     * the same module run in parallel.
     *
     * Failure policy: hooks release resources that each own, and one hook
     * failing says nothing about whether the others can still succeed. Every
     * hook therefore runs, a module whose dependency failed runs once that
     * dependency has finished, and the returned promise settles only after all
     * of them have settled. It then rejects with the single failure, or with an
     * `AggregateError` of all failures in registration order (module by module,
     * handlers in the order they were added).
     */
    async executeAll(): Promise<void> {
        if (!this._hooks.size) return;

        this._pendingPromises.clear();
        this._failures.clear();

        await Promise.all(Array.from(this._hooks.keys()).map((key) => this._executeModule(key)));

        const failures = Array.from(this._hooks.keys()).flatMap((key) => this._failures.get(key) ?? []);
        if (failures.length === 1) {
            throw failures[0];
        }
        if (failures.length > 1) {
            throw new AggregateError(failures, `${failures.length} shutdown hooks failed`);
        }
    }

    /**
     * Tests if a module has a cycle in the dependency graph.
     *
     * Uses DFS traversal to detect back edges in the dependency graph.
     *
     * @param name - Module name to test
     * @param visited - Set of already visited nodes (for recursion)
     * @returns True if a cycle is detected
     */
    private _testForCycles(name: string, visited = new Set<string>()): boolean {
        if (visited.has(name)) return true;

        visited.add(name);
        const deps = this._dependencyTree.get(name) || [];
        return deps.some((dep) => this._testForCycles(dep, new Set(visited)));
    }

    /**
     * Executes a single module's shutdown hooks and its dependencies.
     *
     * Dependencies are executed first (recursively) and awaited whether they
     * succeeded or failed. Results are memoized in `_pendingPromises` to avoid
     * duplicate execution within a single `executeAll()` run. The returned
     * promise never rejects: a handler's failure is recorded in `_failures`
     * under the module name, so that a failing module neither stops its
     * dependents nor hides the failures of other modules.
     *
     * @param name - Module name to execute
     */
    private async _executeModule(name: string): Promise<void> {
        if (this._pendingPromises.has(name)) {
            return await this._pendingPromises.get(name);
        }

        const modulePromise = (async () => {
            const deps = this._dependencyTree.get(name) || [];
            if (deps.length) {
                await Promise.all(deps.map((dep) => this._executeModule(dep)));
            }

            const moduleHandlers = this._hooks.get(name) || [];
            if (moduleHandlers.length) {
                // The handler is called synchronously, so a hook that throws
                // before its first `await` is recorded like one that rejects.
                const outcomes = await Promise.allSettled(moduleHandlers.map((f) => new Promise<void>((resolve) => resolve(f()))));
                const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected").map((outcome) => outcome.reason);
                if (failures.length) {
                    this._failures.set(name, failures);
                }
            }
        })();

        this._pendingPromises.set(name, modulePromise);
        await modulePromise;
    }
}
