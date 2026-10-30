// Gate check — an exported error class keeps its public name in the packed build.
//
// A bundler that sees a class refer to itself (`Object.setPrototypeOf(this,
// MyError.prototype)`, a static factory, an `instanceof` in a method) may emit the
// class expression with an inner binding: `var MyError = class _MyError extends Error`.
// That inner name becomes `MyError.name`, so `constructor.name` in logs, the first
// line of an uncaught stack trace and name-based error matching all show
// `_MyError`, while the `name` instance field (set by hand) still says `MyError`.
// Sources and tests run unbundled and never see it, so only the packed build shows it.
//
// For every error class exported by every subpath of every packed package this
// check compares `Class.name` with the name it is exported under (an alias that
// matches some export of the same value is fine), and for classes whose
// constructor takes a single string it also builds one instance and compares
// `constructor.name` and the first line of its `stack` and of `util.inspect`.
// Executable entries are skipped with the reason recorded in allowlist.mjs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import { importExceptionReason } from "./allowlist.mjs";

const NM = resolve("node_modules", "@connectum");
const pkgs = readdirSync(NM).filter((d) => existsSync(join(NM, d, "package.json")));

let fail = 0;
let checked = 0;
let instantiated = 0;
for (const pkg of pkgs.sort()) {
    const pj = JSON.parse(readFileSync(join(NM, pkg, "package.json"), "utf8"));
    const specs = Object.keys(pj.exports || {})
        .filter((key) => key !== "./package.json")
        .map((key) => (key === "." ? `@connectum/${pkg}` : `@connectum/${pkg}/${key.slice(2)}`))
        .filter((spec) => importExceptionReason(spec) === null);

    for (const spec of specs) {
        const mod = await import(spec);
        for (const [exportName, value] of Object.entries(mod)) {
            if (typeof value !== "function" || !(value.prototype instanceof Error)) continue;
            checked++;
            const aliases = Object.entries(mod)
                .filter(([, other]) => other === value)
                .map(([alias]) => alias);
            if (!aliases.includes(value.name)) {
                fail++;
                console.log(`XX ${spec} export "${exportName}": class name is ${JSON.stringify(value.name)}, expected ${aliases.map((a) => JSON.stringify(a)).join(" or ")}`);
                continue;
            }
            // A constructor that insists on a structured argument cannot be built
            // blind; the static name check above still covers it.
            let instance;
            try {
                instance = new value("probe");
            } catch {
                continue;
            }
            instantiated++;
            // `inspect` is what Node prints for an uncaught error and for console.log:
            // it swaps in the constructor name when that differs from `name`.
            const head = inspect(instance).split("\n", 1)[0] ?? "";
            const stackHead = String(instance.stack).split("\n", 1)[0] ?? "";
            if (instance.constructor.name !== value.name || head.startsWith("_") || stackHead.startsWith("_")) {
                fail++;
                console.log(
                    `XX ${spec} export "${exportName}": instance reports constructor.name=${JSON.stringify(instance.constructor.name)} name=${JSON.stringify(instance.name)} inspect head=${JSON.stringify(head)} stack head=${JSON.stringify(stackHead)}`,
                );
            }
        }
    }
}

console.log(`class-names: ${checked} exported error classes, ${instantiated} instantiated, failures=${fail}`);
process.exit(fail ? 1 : 0);
