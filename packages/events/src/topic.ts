/**
 * Topic name resolution from proto method descriptors.
 *
 * Resolves the event topic for a method by checking the custom
 * `(event).topic` proto option, falling back to the input
 * message's typeName.
 *
 * @module topic
 */

import type { DescMethod } from "@bufbuild/protobuf";
import { getOption, hasOption } from "@bufbuild/protobuf";
import { event } from "#gen/connectum/events/v1/options_pb.js";

/**
 * Resolve the topic name for an event handler method.
 *
 * Priority:
 * 1. Custom option: `option (connectum.events.v1.event).topic = "custom"`
 * 2. Default: `method.input.typeName` (e.g., "mypackage.UserCreated")
 */
export function resolveTopicName(method: DescMethod): string {
    if (hasOption(method, event)) {
        const opts = getOption(method, event);
        if (opts.topic !== "") {
            return opts.topic;
        }
    }
    return method.input.typeName;
}
