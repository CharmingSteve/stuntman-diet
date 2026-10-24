import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

const endpoint = process.env.DYNAMODB_ENDPOINT;
const url = new URL(endpoint);
assert.ok(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash,
"CI DynamoDB must be an uncredentialed loopback HTTP endpoint");
const deadline = Date.now() + 60000;
while (true) {
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(2000) });
    // DynamoDB's unsigned-request error still proves the local HTTP API is ready.
    if (response.status === 400) {
      console.info("DynamoDB Local is ready; both store contract backends are enabled.");
      break;
    }
  } catch { /* Retry bounded startup connection failures. */ }
  assert.ok(Date.now() < deadline, "DynamoDB Local did not become ready within 60 seconds");
  await sleep(1000);
}
