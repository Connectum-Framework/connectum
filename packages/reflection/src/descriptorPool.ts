/**
 * Descriptor pool backing the reflection service.
 *
 * Indexes the server's file descriptors once, so that every reflection query
 * is a map lookup. Names are derived from `FileDescriptorProto` with protobuf
 * scoping rules rather than from protobuf-es `Desc*` objects, because those
 * omit the synthetic map-entry messages (`Foo.BarEntry`) that protobuf name
 * resolution — and therefore a reflection client — can ask for.
 *
 * @module @connectum/reflection/descriptorPool
 */

import { toBinary } from "@bufbuild/protobuf";
import { type DescriptorProto, type EnumDescriptorProto, type FieldDescriptorProto, type FileDescriptorProto, FileDescriptorProtoSchema } from "@bufbuild/protobuf/wkt";

/** A file of the pool, ready to be sent. */
export interface PoolFile {
    /** File name, e.g. `fixture/v1/service.proto`. */
    readonly name: string;
    /** The serialized `FileDescriptorProto`. */
    readonly bytes: Uint8Array;
    /** Names of the files this file imports, in declaration order. */
    readonly dependencies: readonly string[];
}

/** Read-only index over the descriptors a server exposes through reflection. */
export interface DescriptorPool {
    /** Full names of the services to list, in registration order. */
    readonly services: readonly string[];
    /** The file with the given name. */
    fileByName(name: string): PoolFile | undefined;
    /** The file declaring the given fully-qualified symbol. */
    fileContainingSymbol(symbol: string): PoolFile | undefined;
    /** The file declaring extension `number` of message type `extendee`. */
    fileContainingExtension(extendee: string, number: number): PoolFile | undefined;
    /**
     * Extension numbers of message type `messageType`, ascending; `undefined`
     * when the pool declares no message with that name.
     */
    extensionNumbersOf(messageType: string): number[] | undefined;
    /**
     * The serialized `file` followed by its transitive imports that are not in
     * `sent`, each once. `file` itself is always included. Every returned file
     * is added to `sent`, so a stream passes the same set to every call.
     */
    withDependencies(file: PoolFile, sent: Set<string>): Uint8Array[];
}

function scoped(scope: string, name: string): string {
    return scope === "" ? name : `${scope}.${name}`;
}

/**
 * Build a pool from file descriptors that are closed under imports.
 *
 * @param options.files - Every file to expose, including all imports.
 * @param options.services - Full names of the services `list_services` returns.
 */
export function createDescriptorPool(options: { files: ReadonlyArray<FileDescriptorProto>; services: ReadonlyArray<string> }): DescriptorPool {
    const files = new Map<string, PoolFile>();
    const symbols = new Map<string, PoolFile>();
    const messageTypes = new Set<string>();
    // extendee full name → extension number → declaring file
    const extensions = new Map<string, Map<number, PoolFile>>();

    for (const proto of options.files) {
        if (files.has(proto.name)) {
            continue;
        }
        const file: PoolFile = {
            name: proto.name,
            bytes: toBinary(FileDescriptorProtoSchema, proto),
            dependencies: [...proto.dependency],
        };
        files.set(file.name, file);

        // A valid descriptor pool has no duplicate full names; keep the first
        // declaration if an invalid one does.
        const declare = (symbol: string): void => {
            if (!symbols.has(symbol)) {
                symbols.set(symbol, file);
            }
        };
        const declareExtension = (extension: FieldDescriptorProto, scope: string): void => {
            declare(scoped(scope, extension.name));
            // Descriptors produced by protoc and buf carry fully-qualified
            // type references with a leading dot.
            const extendee = extension.extendee.startsWith(".") ? extension.extendee.slice(1) : extension.extendee;
            let numbers = extensions.get(extendee);
            if (numbers === undefined) {
                numbers = new Map();
                extensions.set(extendee, numbers);
            }
            if (!numbers.has(extension.number)) {
                numbers.set(extension.number, file);
            }
        };
        const declareEnum = (enumType: EnumDescriptorProto, scope: string): void => {
            declare(scoped(scope, enumType.name));
            // Enum values are siblings of their enum, not children of it.
            for (const value of enumType.value) {
                declare(scoped(scope, value.name));
            }
        };
        const declareMessage = (message: DescriptorProto, scope: string): void => {
            const fullName = scoped(scope, message.name);
            declare(fullName);
            messageTypes.add(fullName);
            for (const field of message.field) {
                declare(scoped(fullName, field.name));
            }
            for (const oneof of message.oneofDecl) {
                declare(scoped(fullName, oneof.name));
            }
            for (const nested of message.nestedType) {
                declareMessage(nested, fullName);
            }
            for (const enumType of message.enumType) {
                declareEnum(enumType, fullName);
            }
            for (const extension of message.extension) {
                declareExtension(extension, fullName);
            }
        };

        const pkg = proto.package;
        for (const message of proto.messageType) {
            declareMessage(message, pkg);
        }
        for (const enumType of proto.enumType) {
            declareEnum(enumType, pkg);
        }
        for (const extension of proto.extension) {
            declareExtension(extension, pkg);
        }
        for (const service of proto.service) {
            const fullName = scoped(pkg, service.name);
            declare(fullName);
            for (const method of service.method) {
                declare(scoped(fullName, method.name));
            }
        }
    }

    const services = Object.freeze([...options.services]);

    return {
        services,
        fileByName: (name) => files.get(name),
        fileContainingSymbol: (symbol) => symbols.get(symbol),
        fileContainingExtension: (extendee, number) => extensions.get(extendee)?.get(number),
        extensionNumbersOf(messageType) {
            if (!messageTypes.has(messageType)) {
                return undefined;
            }
            return [...(extensions.get(messageType)?.keys() ?? [])].sort((a, b) => a - b);
        },
        withDependencies(file, sent) {
            const result = [file.bytes];
            sent.add(file.name);
            // Breadth-first over imports; `expanded` keeps a diamond-shaped
            // import graph from being walked more than once.
            const expanded = new Set([file.name]);
            const queue = [...file.dependencies];
            for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
                if (expanded.has(name)) {
                    continue;
                }
                expanded.add(name);
                const dependency = files.get(name);
                if (dependency === undefined) {
                    continue;
                }
                if (!sent.has(name)) {
                    sent.add(name);
                    result.push(dependency.bytes);
                }
                queue.push(...dependency.dependencies);
            }
            return result;
        },
    };
}
