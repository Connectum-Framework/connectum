/**
 * Reflection utility functions
 *
 * @module @connectum/reflection/utils
 */

import type { DescFile } from "@bufbuild/protobuf";

/**
 * Recursively collect FileDescriptorProto objects from DescFile entries,
 * including transitive dependencies.
 *
 * Dependencies are visited depth-first before the file itself,
 * and duplicates are eliminated by file name.
 *
 * @param files - Array of DescFile entries to collect protos from
 * @returns Deduplicated array of FileDescriptorProto objects
 */
export function collectFileProtos(files: ReadonlyArray<DescFile>): DescFile["proto"][] {
    const visited = new Set<string>();
    const result: DescFile["proto"][] = [];

    function visit(file: DescFile): void {
        if (visited.has(file.name)) {
            return;
        }
        visited.add(file.name);

        // Visit dependencies first (depth-first)
        for (const dep of file.dependencies) {
            visit(dep);
        }

        result.push(file.proto);
    }

    for (const file of files) {
        visit(file);
    }

    return result;
}
