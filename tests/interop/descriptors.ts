/**
 * Minimal readers for serialized descriptors, written by hand on purpose.
 *
 * The interop suites compare what the server sends with what independent
 * clients receive. Decoding those bytes with protobuf-es would use the library
 * the server is built on, so a defect shared by both could go unnoticed. These
 * readers decode only the fields the suites need, straight from the protobuf
 * wire format.
 */

export interface FileDescriptorInfo {
    /** `FileDescriptorProto.name` (field 1). */
    name: string;
    /** `FileDescriptorProto.dependency` (field 3), in declaration order. */
    dependencies: string[];
    /** The serialized `FileDescriptorProto` itself. */
    bytes: Buffer;
}

/** Visit the length-delimited fields of a message; other wire types are skipped. */
function forEachBytesField(bytes: Uint8Array, visit: (field: number, value: Buffer) => void): void {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    const varint = (): number => {
        let result = 0;
        let shift = 0;
        for (;;) {
            const byte = buffer[offset++];
            if (byte === undefined) {
                throw new Error("truncated varint");
            }
            result += (byte & 0x7f) * 2 ** shift;
            if (byte < 0x80) {
                return result;
            }
            shift += 7;
        }
    };
    while (offset < buffer.length) {
        const tag = varint();
        const field = Math.floor(tag / 8);
        const wireType = tag % 8;
        if (wireType === 2) {
            const length = varint();
            visit(field, buffer.subarray(offset, offset + length));
            offset += length;
        } else if (wireType === 0) {
            varint();
        } else if (wireType === 1) {
            offset += 8;
        } else if (wireType === 5) {
            offset += 4;
        } else {
            throw new Error(`unexpected wire type ${wireType}`);
        }
    }
}

/** Read the name and imports of a serialized `FileDescriptorProto`. */
export function readFileDescriptor(bytes: Uint8Array): FileDescriptorInfo {
    let name: string | undefined;
    const dependencies: string[] = [];
    forEachBytesField(bytes, (field, value) => {
        if (field === 1) {
            name = value.toString("utf8");
        } else if (field === 3) {
            dependencies.push(value.toString("utf8"));
        }
    });
    if (name === undefined) {
        throw new Error("FileDescriptorProto has no name");
    }
    return { name, dependencies, bytes: Buffer.from(bytes) };
}

/** Read the files of a serialized `FileDescriptorSet` (field 1, repeated), in order. */
export function readFileDescriptorSet(bytes: Uint8Array): FileDescriptorInfo[] {
    const files: FileDescriptorInfo[] = [];
    forEachBytesField(bytes, (field, value) => {
        if (field === 1) {
            files.push(readFileDescriptor(value));
        }
    });
    return files;
}
