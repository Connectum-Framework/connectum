/**
 * Name rules for `connectum generate service`.
 *
 * The name is turned into a proto package, a proto service, a TypeScript binding and two file
 * paths by keeping only ASCII letters and digits. A name that holds anything else would be
 * changed without notice (`a/b` becomes `ab`, `Привет-billing` becomes `billing`), so the
 * command refuses it instead, the way `connectum init` refuses an invalid project name.
 *
 * @module scaffold/serviceName
 */

/** Longest accepted name; the longest file derived from it (`<name>Service.ts`) stays far below the 255-byte limit of a file name. */
export const MAX_SERVICE_NAME_LENGTH = 214;

/** Characters a name may consist of: `-` and `_` separate the words of the derived identifiers. */
const ALLOWED_CHARACTERS = /^[A-Za-z0-9_-]*$/;

/** Every character that is not allowed, once each, in order of appearance. */
function disallowedCharacters(name: string): string[] {
    const found = new Set<string>();
    for (const character of name) {
        if (!/^[A-Za-z0-9_-]$/.test(character)) {
            found.add(character);
        }
    }
    return [...found];
}

/**
 * Every rule `name` breaks, in a fixed order; empty when the name is acceptable.
 *
 * @param name - The service name, already trimmed and not empty
 */
export function serviceNameProblems(name: string): string[] {
    const problems: string[] = [];
    if ([...name].length > MAX_SERVICE_NAME_LENGTH) {
        problems.push(`it is longer than ${MAX_SERVICE_NAME_LENGTH} characters`);
    }
    if (!/^[A-Za-z]/.test(name)) {
        problems.push("it must start with a letter (a-z, A-Z)");
    }
    if (!ALLOWED_CHARACTERS.test(name)) {
        const shown = disallowedCharacters(name)
            .map((character) => JSON.stringify(character))
            .join(", ");
        problems.push(`it contains ${shown}, but only ASCII letters, digits, "-" and "_" are allowed`);
    }
    return problems;
}
