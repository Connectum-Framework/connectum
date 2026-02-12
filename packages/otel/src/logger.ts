import { trace } from "@opentelemetry/api";
import type { AnyValueMap, LogRecord } from "@opentelemetry/api-logs";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { ATTR_RPC_SERVICE } from "./attributes.ts";
import { getProvider } from "./provider.ts";

export interface LoggerOptions {
    defaultAttributes?: AnyValueMap;
}

export interface Logger {
    info(message: string, attributes?: AnyValueMap): void;
    warn(message: string, attributes?: AnyValueMap): void;
    error(message: string, attributes?: AnyValueMap): void;
    debug(message: string, attributes?: AnyValueMap): void;
    emit(record: LogRecord): void;
}

function resolveServiceName(): string | undefined {
    const span = trace.getActiveSpan();
    if (span && "attributes" in span) {
        const service = (span as { attributes: Record<string, unknown> }).attributes[ATTR_RPC_SERVICE];
        if (typeof service === "string") return service;
    }
    return undefined;
}

export function getLogger(name?: string, options?: LoggerOptions): Logger {
    const otelLogger = getProvider().logger;
    const defaultAttrs = options?.defaultAttributes;

    function buildAttributes(callAttributes?: AnyValueMap): AnyValueMap {
        const loggerName = name ?? resolveServiceName() ?? "unknown";
        const base: AnyValueMap = { "logger.name": loggerName, ...defaultAttrs };
        return callAttributes ? { ...base, ...callAttributes } : base;
    }

    function emitLog(severityNumber: SeverityNumber, severityText: string, message: string, attributes?: AnyValueMap): void {
        otelLogger.emit({
            severityNumber,
            severityText,
            body: message,
            attributes: buildAttributes(attributes),
        });
    }

    return {
        info(message, attributes?) {
            emitLog(SeverityNumber.INFO, "INFO", message, attributes);
        },
        warn(message, attributes?) {
            emitLog(SeverityNumber.WARN, "WARN", message, attributes);
        },
        error(message, attributes?) {
            emitLog(SeverityNumber.ERROR, "ERROR", message, attributes);
        },
        debug(message, attributes?) {
            emitLog(SeverityNumber.DEBUG, "DEBUG", message, attributes);
        },
        emit(record) {
            otelLogger.emit(record);
        },
    };
}
