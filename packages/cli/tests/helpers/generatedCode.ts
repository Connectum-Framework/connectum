/**
 * Structural inspection of the TypeScript text that `connectum init` and `connectum generate
 * service` emit, and an independent source of truth for the names that text refers to.
 *
 * Generated modules are never compiled by the unit tests, so a regular expression over the raw
 * text cannot tell code from a comment or a string, and cannot tell a real identifier from a
 * typo. This helper parses the text with the TypeScript compiler API (syntax only, no type
 * information) and resolves the names it uses against the sources of the workspace packages
 * that actually export them. The workspace packages are the oracle: they are the API a
 * generated project installs, and they do not depend on the generator under test.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** The `packages/` directory of the monorepo. */
const PACKAGES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Parse a generated module. Fails when the text is not syntactically valid TypeScript.
 */
export function parseGenerated(source: string, fileName = "generated.ts"): ts.SourceFile {
    const { diagnostics } = ts.transpileModule(source, {
        fileName,
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
    });
    if (diagnostics !== undefined && diagnostics.length > 0) {
        const messages = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
        throw new Error(`generated ${fileName} is not valid TypeScript:\n${messages.join("\n")}\n--- source ---\n${source}`);
    }
    return ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
}

/** One `import` declaration of a module. */
export interface ImportRecord {
    /** Module specifier. */
    from: string;
    /** Names imported from it (the exported name, not a local alias); `default` for a default import. */
    names: string[];
    /** True for `import type { ... }`. */
    typeOnly: boolean;
}

/** All import declarations of a generated module, in source order. */
export function importsOf(sf: ts.SourceFile): ImportRecord[] {
    const records: ImportRecord[] = [];
    for (const statement of sf.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
            continue;
        }
        const names: string[] = [];
        const clause = statement.importClause;
        if (clause?.name !== undefined) {
            names.push("default");
        }
        const bindings = clause?.namedBindings;
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
                names.push((element.propertyName ?? element.name).text);
            }
        } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
            names.push("*");
        }
        records.push({ from: statement.moduleSpecifier.text, names, typeOnly: clause?.isTypeOnly ?? false });
    }
    return records;
}

/** Every node of the tree for which `pick` returns a value. */
function collect<T>(root: ts.Node, pick: (node: ts.Node) => T | undefined): T[] {
    const found: T[] = [];
    const visit = (node: ts.Node): void => {
        const hit = pick(node);
        if (hit !== undefined) {
            found.push(hit);
        }
        ts.forEachChild(node, visit);
    };
    visit(root);
    return found;
}

/** Every node of the tree (the root included) that satisfies a type guard. */
export function collectNodes<T extends ts.Node>(root: ts.Node, guard: (node: ts.Node) => node is T): T[] {
    return collect(root, (node) => (guard(node) ? node : undefined));
}

/** Every call expression whose callee is written exactly as `callee` (for example `client.sayHello`). */
export function callsTo(root: ts.Node, callee: string): ts.CallExpression[] {
    return collect(root, (node) => (ts.isCallExpression(node) && node.expression.getText() === callee ? node : undefined));
}

/** The source text of each argument of a call. */
export function argumentsOf(call: ts.CallExpression): string[] {
    return call.arguments.map((argument) => argument.getText());
}

/**
 * The property names of an object literal argument, in order, with the source text of each
 * initializer (shorthand properties and spreads are reported under their own text).
 */
export function propertiesOf(objectLiteral: ts.Node): Array<{ name: string; value: string }> {
    assertKind(ts.isObjectLiteralExpression(objectLiteral), `expected an object literal, got: ${objectLiteral.getText()}`);
    return (objectLiteral as ts.ObjectLiteralExpression).properties.map((property) => {
        if (ts.isPropertyAssignment(property)) {
            return { name: property.name.getText(), value: property.initializer.getText() };
        }
        return { name: property.getText(), value: property.getText() };
    });
}

function assertKind(condition: boolean, message: string): void {
    if (!condition) {
        throw new Error(message);
    }
}

/** The `createServer({ ... })` options object of a generated composition root. */
export function createServerOptions(sf: ts.SourceFile): ts.ObjectLiteralExpression {
    const [call] = callsTo(sf, "createServer");
    assertKind(call !== undefined, "no createServer(...) call");
    const [options] = (call as ts.CallExpression).arguments;
    assertKind(options !== undefined && ts.isObjectLiteralExpression(options), "createServer must receive an object literal");
    return options as ts.ObjectLiteralExpression;
}

/** The initializer of one property of an object literal. */
export function propertyValue(objectLiteral: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
    for (const property of objectLiteral.properties) {
        if (ts.isPropertyAssignment(property) && property.name.getText() === name) {
            return property.initializer;
        }
    }
    return undefined;
}

/** The source text of each element of an array literal. */
export function elementsOf(expression: ts.Expression | undefined): string[] {
    assertKind(expression !== undefined && ts.isArrayLiteralExpression(expression), `expected an array literal, got: ${expression?.getText()}`);
    return (expression as ts.ArrayLiteralExpression).elements.map((element) => element.getText());
}

/** The names of the `export const` / `export function` bindings of a module. */
export function exportedBindings(sf: ts.SourceFile): string[] {
    const names: string[] = [];
    for (const statement of sf.statements) {
        const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
        if (!exported) {
            continue;
        }
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                names.push(declaration.name.getText());
            }
        } else if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
            names.push(statement.name.text);
        }
    }
    return names;
}

/** The rpc method names declared by `service <service> { ... }` in a proto file, in order. */
export function protoRpcMethods(proto: string, service: string): string[] {
    const body = proto.match(new RegExp(`^service ${service} \\{\\n([\\s\\S]*?)\\n\\}$`, "m"))?.[1];
    if (body === undefined) {
        throw new Error(`service ${service} is not declared in:\n${proto}`);
    }
    return [...body.matchAll(/\brpc (\w+)\(/g)].map((m) => m[1] as string);
}

// ---- Names exported by the workspace packages -------------------------------------------------

/** `@connectum/core` -> `<packages>/core`. */
function workspacePackageDir(specifier: string): string | undefined {
    const match = /^@connectum\/([^/]+)(\/.*)?$/.exec(specifier);
    if (match === null) {
        return undefined;
    }
    const dir = join(PACKAGES_DIR, match[1] as string);
    return existsSync(join(dir, "package.json")) ? dir : undefined;
}

/** Source file a package `exports` target (`./dist/proto/index.js`) is built from. */
function sourceOfExportTarget(packageDir: string, target: string): string {
    return join(packageDir, target.replace(/^\.\/dist\//, "src/").replace(/\.d\.ts$|\.js$/, ".ts"));
}

function resolveRelative(fromFile: string, specifier: string): string {
    const candidate = resolve(dirname(fromFile), specifier.replace(/\.js$/, ".ts"));
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        return join(candidate, "index.ts");
    }
    return candidate;
}

function collectExports(file: string, names: Set<string>, visited: Set<string>): void {
    if (visited.has(file)) {
        return;
    }
    visited.add(file);
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    for (const statement of sf.statements) {
        if (ts.isExportDeclaration(statement)) {
            const clause = statement.exportClause;
            if (clause !== undefined && ts.isNamedExports(clause)) {
                for (const element of clause.elements) {
                    names.add(element.name.text);
                }
            } else if (clause !== undefined && ts.isNamespaceExport(clause)) {
                names.add(clause.name.text);
            } else if (statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)) {
                const specifier = statement.moduleSpecifier.text;
                if (specifier.startsWith(".")) {
                    collectExports(resolveRelative(file, specifier), names, visited);
                } else {
                    for (const name of exportedNames(specifier)) {
                        names.add(name);
                    }
                }
            }
            continue;
        }
        const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
        if (!exported) {
            continue;
        }
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) {
                    names.add(declaration.name.text);
                }
            }
        } else if (
            (ts.isFunctionDeclaration(statement) ||
                ts.isClassDeclaration(statement) ||
                ts.isInterfaceDeclaration(statement) ||
                ts.isTypeAliasDeclaration(statement) ||
                ts.isEnumDeclaration(statement)) &&
            statement.name !== undefined
        ) {
            names.add(statement.name.text);
        }
    }
}

/**
 * Every name a workspace package exports under `specifier` (for example `@connectum/testing` or
 * `@connectum/auth/proto`), read from the package sources through its `exports` map.
 *
 * @throws Error when the specifier does not name a workspace package or an export of it
 */
export function exportedNames(specifier: string): Set<string> {
    const packageDir = workspacePackageDir(specifier);
    if (packageDir === undefined) {
        throw new Error(`"${specifier}" is not a workspace package`);
    }
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { exports?: Record<string, { types?: string; default?: string } | string> };
    const subpath = specifier.replace(/^@connectum\/[^/]+/, "") === "" ? "." : `.${specifier.replace(/^@connectum\/[^/]+/, "")}`;
    const entry = manifest.exports?.[subpath];
    const target = typeof entry === "string" ? entry : (entry?.types ?? entry?.default);
    if (target === undefined) {
        throw new Error(`${specifier}: no "${subpath}" entry in the exports of ${packageDir}/package.json`);
    }
    const names = new Set<string>();
    collectExports(sourceOfExportTarget(packageDir, target), names, new Set());
    return names;
}

/** The property names declared by `interface <name>` in a file of the workspace (path relative to `packages/`). */
export function interfaceKeys(relativePath: string, name: string): Set<string> {
    const file = join(PACKAGES_DIR, relativePath);
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    for (const statement of sf.statements) {
        if (ts.isInterfaceDeclaration(statement) && statement.name.text === name) {
            return new Set(statement.members.flatMap((member) => (ts.isPropertySignature(member) ? [member.name.getText()] : [])));
        }
    }
    throw new Error(`interface ${name} not found in ${relativePath}`);
}

/**
 * The names the generated module imports from a `@connectum/*` package that the package does not
 * export (empty when every import resolves). Other specifiers (relative aliases, third-party
 * packages) are not checked.
 */
export function unresolvedWorkspaceImports(sf: ts.SourceFile): string[] {
    const problems: string[] = [];
    for (const record of importsOf(sf)) {
        if (workspacePackageDir(record.from) === undefined) {
            continue;
        }
        const available = exportedNames(record.from);
        for (const name of record.names) {
            if (!available.has(name)) {
                problems.push(`${record.from} has no export "${name}"`);
            }
        }
    }
    return problems;
}
