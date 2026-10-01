/**
 * Minimum dependency versions a scaffolded project must declare — the single place
 * that owns them.
 *
 * `connectum init` copies the fetched base's `package.json`, but the code the project
 * generates is decided by the CLI (it writes `buf.gen.yaml` itself). When that generated
 * code needs a newer dependency than an older base declares — a base picked with
 * `--ref`, for example — the base range must not win, or the scaffold ships a manifest
 * that allows versions its own generated code cannot use. Every such floor is listed
 * here and applied by the `package.json` transform; the scaffold check reads the same
 * table to assert the result.
 *
 * @module scaffold/versionFloors
 */

/** The `package.json` block a floored dependency belongs to. */
export type ManifestSection = "dependencies" | "devDependencies";

/** One dependency floor. */
export interface VersionFloor {
    readonly section: ManifestSection;
    readonly name: string;
    /** Lowest acceptable version, `major.minor.patch`; written as a caret range. */
    readonly version: string;
}

/**
 * protobuf-es floor. `erasable_syntax=true` (enums as `as const` objects, which native
 * type stripping and `erasableSyntaxOnly` require) first ships in protoc-gen-es 2.13.0,
 * and its output imports `UnknownEnum`, which `@bufbuild/protobuf` exports since 2.13.0.
 * 2.16.0 is the version the scaffold base and its checks are verified against; the
 * generator and the runtime move together because the generated code imports the runtime.
 * It also covers `map_imports`, which the generated `buf.gen.yaml` passes with the auth
 * or events module and which first ships in protoc-gen-es 2.15.0.
 */
const PROTOBUF_ES_FLOOR = "2.16.0";

/** Every floor `connectum init` enforces on the scaffolded `package.json`. */
export const SCAFFOLD_VERSION_FLOORS: readonly VersionFloor[] = [
    { section: "dependencies", name: "@bufbuild/protobuf", version: PROTOBUF_ES_FLOOR },
    { section: "devDependencies", name: "@bufbuild/protoc-gen-es", version: PROTOBUF_ES_FLOOR },
];

type Version = readonly [number, number, number];

function parseVersion(version: string): Version | undefined {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (match === null) {
        return undefined;
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: Version, b: Version): number {
    for (let i = 0; i < 3; i++) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}

/**
 * Whether `range` is known to start at or above `version`.
 *
 * Only the forms the scaffold bases use are read: `^X.Y.Z`, `~X.Y.Z` and an exact
 * `X.Y.Z`, whose lower bound is the stated version. Anything else — a missing range,
 * `>=`, `*`, a tag, a prerelease — cannot be shown to meet the floor and reads as `false`.
 */
export function meetsFloor(range: string | undefined, version: string): boolean {
    const floor = parseVersion(version);
    if (floor === undefined) {
        throw new Error(`versionFloors: "${version}" is not a major.minor.patch version`);
    }
    const lower = range === undefined ? undefined : parseVersion(range.replace(/^[\^~]/, ""));
    return lower !== undefined && compareVersions(lower, floor) >= 0;
}

/**
 * Apply the floors of one manifest section: a range below its floor, absent, or in a
 * form {@link meetsFloor} cannot read becomes `^<floor>`; a range already at or above
 * the floor is kept, so a newer base is never pulled down. Returns a new object; key
 * order is the caller's concern.
 */
export function applyVersionFloors(section: ManifestSection, deps: Readonly<Record<string, string>>): Record<string, string> {
    const out: Record<string, string> = { ...deps };
    for (const floor of SCAFFOLD_VERSION_FLOORS) {
        if (floor.section === section && !meetsFloor(out[floor.name], floor.version)) {
            out[floor.name] = `^${floor.version}`;
        }
    }
    return out;
}

/** A floor shared by every package of a scope, applied only when the manifest depends on a trigger. */
export interface SliceFloor {
    /** Package-name prefix of the slice, e.g. `@connectum/`. */
    readonly scope: string;
    /** Lowest acceptable version, `major.minor.patch`; written as a caret range. */
    readonly version: string;
    /** The floor applies when `dependencies` lists any of these packages. */
    readonly triggers: readonly string[];
}

/**
 * The `@connectum/*` floor for a project whose generated code imports Connectum's option
 * descriptors from a package (`map_imports` in the generated `buf.gen.yaml`, which the
 * auth and events modules turn on). The `./gen/connectum/{auth,events}/v1/options_pb.js`
 * subpaths first ship in 1.3.0; below it the generated imports cannot resolve.
 *
 * The whole slice moves, not just the two packages: mixed `@connectum/*` minors install
 * two copies of the protobuf runtime and the generated handlers stop type-checking. A
 * project without either package keeps the base's ranges — its generated code imports
 * nothing from Connectum, so a floor there would only block installing published
 * versions that work.
 */
export const CONNECTUM_SLICE_FLOOR: SliceFloor = {
    scope: "@connectum/",
    version: "1.3.0",
    triggers: ["@connectum/auth", "@connectum/events"],
};

/** Whether {@link CONNECTUM_SLICE_FLOOR} applies to a manifest with these runtime dependencies. */
export function connectumSliceFloorApplies(dependencies: Readonly<Record<string, string>>): boolean {
    return CONNECTUM_SLICE_FLOOR.triggers.some((name) => name in dependencies);
}

/**
 * The one range every `@connectum/*` entry of the project gets. `baseRange` (the base's
 * `@connectum/core` range) is kept when the floor does not apply or is already met, so a
 * newer base is never pulled down; otherwise it is `^<floor>`.
 */
export function connectumSliceRange(baseRange: string, dependencies: Readonly<Record<string, string>>): string {
    if (!connectumSliceFloorApplies(dependencies) || meetsFloor(baseRange, CONNECTUM_SLICE_FLOOR.version)) {
        return baseRange;
    }
    return `^${CONNECTUM_SLICE_FLOOR.version}`;
}

/** Set every `@connectum/*` entry of `deps` to `range`. Returns a new object. */
export function alignConnectumSlice(deps: Readonly<Record<string, string>>, range: string): Record<string, string> {
    return Object.fromEntries(Object.entries(deps).map(([name, spec]) => [name, name.startsWith(CONNECTUM_SLICE_FLOOR.scope) ? range : spec]));
}

/**
 * Check a scaffolded manifest against {@link CONNECTUM_SLICE_FLOOR}: when it applies,
 * every `@connectum/*` entry in `dependencies` and `devDependencies` must declare the
 * same range, and that range must meet the floor. Returns one message per problem
 * (empty when the manifest is fine or the floor does not apply).
 */
export function connectumSliceViolations(manifest: {
    readonly dependencies?: Readonly<Record<string, string>> | undefined;
    readonly devDependencies?: Readonly<Record<string, string>> | undefined;
}): string[] {
    const dependencies = manifest.dependencies ?? {};
    if (!connectumSliceFloorApplies(dependencies)) {
        return [];
    }
    const entries = [...Object.entries(dependencies), ...Object.entries(manifest.devDependencies ?? {})].filter(([name]) => name.startsWith(CONNECTUM_SLICE_FLOOR.scope));
    const problems: string[] = [];
    const ranges = new Set(entries.map(([, range]) => range));
    if (ranges.size > 1) {
        problems.push(`@connectum/* ranges differ: ${entries.map(([name, range]) => `${name}@${range}`).join(", ")}`);
    }
    for (const [name, range] of entries) {
        if (!meetsFloor(range, CONNECTUM_SLICE_FLOOR.version)) {
            problems.push(`${name} is ${JSON.stringify(range)}, below the floor ${CONNECTUM_SLICE_FLOOR.version}`);
        }
    }
    return problems;
}
