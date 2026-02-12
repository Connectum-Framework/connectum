/**
 * Instance-based shutdown manager with dependency ordering.
 *
 * Clean instance-based class for use within Server instances.
 *
 * Key characteristics:
 * - Does NOT manage process signals (Server handles that)
 * - Does NOT use global state (each Server gets its own instance)
 * - Supports repeated `executeAll()` calls (clears pending promises each time)
 *
 * @module ShutdownManager
 */

/**
 * Shutdown hook function type
 *
 * A function called during graceful shutdown. May be synchronous or async.
 */
export type ShutdownHook = () => void | Promise<void>;

/**
 * Instance-based manager for shutdown hooks with dependency ordering.
 *
 * Handles graceful shutdown of application modules with support for:
 * - Dependency-ordered shutdown (dependencies execute first)
 * - Multiple handlers per named module
 * - Cycle detection in dependency graph
 * - Reusable (can call `executeAll()` multiple times)
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
        } else if (typeof depsOrHandler === "function") {
            // addHook(name, handler)
            name = nameOrHandler;
            handler = depsOrHandler;
            dependencies = [];
        } else {
            // addHook(name, dependencies, handler)
            name = nameOrHandler;
            dependencies = depsOrHandler as string[];
            handler = handlerArg as ShutdownHook;
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
     * the same module run in parallel. The method can be called multiple
     * times (pending promises are cleared before each execution).
     */
    async executeAll(): Promise<void> {
        if (!this._hooks.size) return;

        this._pendingPromises.clear();

        await Promise.all(Array.from(this._hooks.keys()).map((key) => this._executeModule(key)));
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
     * Dependencies are executed first (recursively). Results are memoized
     * in `_pendingPromises` to avoid duplicate execution within a single
     * `executeAll()` run.
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
                await Promise.all(moduleHandlers.map((f) => f()));
            }
        })();

        this._pendingPromises.set(name, modulePromise);
        await modulePromise;
    }
}
