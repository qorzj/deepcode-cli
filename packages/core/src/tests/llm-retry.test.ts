import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getLlmRetryDelayMs,
  getLlmRetryAfterMs,
  isRetryableLlmError,
  LlmStreamDisconnectedError,
  LlmStreamFirstChunkTimeoutError,
  LlmStreamIdleTimeoutError,
  waitForLlmRetry,
} from "../common/llm-retry";

test("getLlmRetryDelayMs applies exponential backoff with ten percent jitter", () => {
  const expected = [800, 1600, 3200, 6400, 12800];
  for (let index = 0; index < expected.length; index += 1) {
    const attempt = index + 1;
    assert.equal(
      getLlmRetryDelayMs(attempt, () => 0),
      Math.round(expected[index]! * 0.9)
    );
    assert.equal(
      getLlmRetryDelayMs(attempt, () => 0.5),
      expected[index]
    );
    assert.equal(
      getLlmRetryDelayMs(attempt, () => 1),
      Math.round(expected[index]! * 1.1)
    );
  }
});

test("getLlmRetryAfterMs honors millisecond, second, and HTTP-date headers", () => {
  const now = Date.parse("2026-09-01T00:00:00.000Z");
  assert.equal(
    getLlmRetryAfterMs(
      Object.assign(new Error("rate limited"), { headers: new Headers({ "retry-after-ms": "1250" }) }),
      now
    ),
    1250
  );
  assert.equal(getLlmRetryAfterMs({ headers: { "Retry-After": "60" } }, now), 60_000);
  assert.equal(getLlmRetryAfterMs({ headers: { "retry-after": "Tue, 01 Sep 2026 00:00:30 GMT" } }, now), 30_000);
});

test("getLlmRetryAfterMs prefers retry-after-ms and ignores invalid headers", () => {
  assert.equal(getLlmRetryAfterMs({ headers: { "retry-after-ms": "2500", "retry-after": "60" } }), 2500);
  assert.equal(getLlmRetryAfterMs({ headers: { "retry-after": "not-a-date" } }), undefined);
  assert.equal(getLlmRetryAfterMs(new Error("no headers")), undefined);
});

test("isRetryableLlmError recognizes recoverable HTTP and transport failures", () => {
  for (const status of [408, 409, 429, 500, 502, 599]) {
    assert.equal(isRetryableLlmError(Object.assign(new Error("API failed"), { status })), true);
  }
  assert.equal(isRetryableLlmError(Object.assign(new Error("Bad request"), { status: 400 })), false);
  assert.equal(isRetryableLlmError(Object.assign(new Error("Unauthorized"), { status: 401 })), false);
  assert.equal(
    isRetryableLlmError(
      new Error("Connection error", { cause: Object.assign(new Error("read failed"), { code: "ECONNRESET" }) })
    ),
    true
  );
  assert.equal(isRetryableLlmError(new LlmStreamIdleTimeoutError()), true);
  assert.equal(isRetryableLlmError(new LlmStreamFirstChunkTimeoutError()), false);
  assert.equal(isRetryableLlmError(new LlmStreamDisconnectedError()), true);
});

test("waitForLlmRetry can be interrupted", async () => {
  const controller = new AbortController();
  const waiting = waitForLlmRetry(60_000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, (error: Error) => error.name === "AbortError");
});
