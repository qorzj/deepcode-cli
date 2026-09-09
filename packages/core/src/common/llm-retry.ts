import { getLlmErrorDetails } from "./llm-error";

export const MAX_LLM_RETRIES = 5;
export const LLM_STREAM_IDLE_TIMEOUT_MS = 60_000;
export const LLM_STREAM_FIRST_CHUNK_TIMEOUT_MS = 300_000;

const BASE_RETRY_DELAY_MS = 800;
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export class LlmStreamIdleTimeoutError extends Error {
  constructor(timeoutMs: number = LLM_STREAM_IDLE_TIMEOUT_MS) {
    super(`Model stream was idle for ${timeoutMs / 1000} seconds.`);
    this.name = "LlmStreamIdleTimeoutError";
  }
}

export class LlmStreamFirstChunkTimeoutError extends Error {
  constructor(timeoutMs: number = LLM_STREAM_FIRST_CHUNK_TIMEOUT_MS) {
    super(`Model stream produced no first chunk for ${timeoutMs / 1000} seconds.`);
    this.name = "LlmStreamFirstChunkTimeoutError";
  }
}

export class LlmStreamDisconnectedError extends Error {
  constructor() {
    super("Model stream disconnected before completion.");
    this.name = "LlmStreamDisconnectedError";
  }
}

export function getLlmRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponentialDelay = BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  const jitter = 0.9 + Math.min(1, Math.max(0, random())) * 0.2;
  return Math.round(exponentialDelay * jitter);
}

export function getLlmRetryAfterMs(error: unknown, now: number = Date.now()): number | undefined {
  const headers = getErrorHeaders(error);
  const retryAfterMs = parseDelay(getHeader(headers, "retry-after-ms"));
  if (retryAfterMs !== undefined) {
    return retryAfterMs;
  }

  const retryAfter = getHeader(headers, "retry-after");
  if (!retryAfter) {
    return undefined;
  }
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function isRetryableLlmError(error: unknown): boolean {
  // A first-chunk timeout commonly means an expensive local-model prefill is
  // still running. Replaying the same large prompt multiplies work without
  // improving recovery, so fail once and let route/fallback policy take over.
  if (error instanceof LlmStreamFirstChunkTimeoutError) {
    return false;
  }
  if (error instanceof LlmStreamIdleTimeoutError || error instanceof LlmStreamDisconnectedError) {
    return true;
  }

  const details = getLlmErrorDetails(error);
  const pending = [details];
  while (pending.length > 0) {
    const detail = pending.shift()!;
    if (
      detail.status === 408 ||
      detail.status === 409 ||
      detail.status === 429 ||
      (detail.status !== undefined && detail.status >= 500 && detail.status <= 599)
    ) {
      return true;
    }
    if (detail.code && RETRYABLE_NETWORK_CODES.has(detail.code.toUpperCase())) {
      return true;
    }
    if (
      /(?:connection (?:error|reset|refused|closed)|fetch failed|network error|socket|timed? ?out|premature close|websocket.*closed)/i.test(
        `${detail.name} ${detail.message}`
      )
    ) {
      return true;
    }
    pending.push(...(detail.causes ?? []));
  }
  return false;
}

export function waitForLlmRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", cancel, { once: true });

    function finish(): void {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }

    function cancel(): void {
      clearTimeout(timer);
      reject(abortError(signal));
    }
  });
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("Request was aborted.");
  error.name = "AbortError";
  return error;
}

function getErrorHeaders(error: unknown): unknown {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record.headers) {
      return record.headers;
    }
    current = record.cause;
  }
  return undefined;
}

function getHeader(headers: unknown, name: string): string | undefined {
  if (headers && typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(name: string): unknown }).get(name);
    return typeof value === "string" ? value.trim() : undefined;
  }
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return undefined;
  }
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return typeof entry?.[1] === "string" ? entry[1].trim() : undefined;
}

function parseDelay(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const delay = Number.parseFloat(value);
  return Number.isFinite(delay) ? Math.max(0, Math.round(delay)) : undefined;
}
