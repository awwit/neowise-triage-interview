import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { after, before, test } from "node:test";

let child;
let baseUrl;

before(async () => {
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  baseUrl = await new Promise((resolve, reject) => {
    let stdout = "";
    const onData = (chunk) => {
      stdout += chunk;
      const match = stdout.match(/Listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        child.stdout.off("data", onData);
        resolve(match[1]);
      }
    };
    child.stdout.setEncoding("utf8").on("data", onData);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(new Error(`Server exited: ${code ?? signal}; ${stderr}`));
    });
  });
}, { timeout: 5_000 });

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
});

async function post(body) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(2_000),
  });
  return { status: response.status, body: await response.json() };
}

const draft = "Спасибо за обращение. Уточним детали заявки.";

for (const [name, body] of [
  ["missing body", ""],
  ["malformed JSON", '{"text":'],
  ["null", "null"],
  ["array", "[]"],
  ["root string", '"hello"'],
  ["root number", "42"],
  ["root boolean", "true"],
  ["missing text", "{}"],
  ...[null, false, 0, {}, [], "", " \t\r\n "].map((text) => [
    `invalid text ${JSON.stringify(text)}`, JSON.stringify({ text }),
  ]),
]) {
  test(`rejects ${name}`, async () => {
    assert.deepEqual(await post(body), {
      status: 400,
      body: { status: "invalid_input" },
    });
  });
}

for (const [text, topic] of [
  ["Когда доставка?", "delivery"],
  ["Какая стоимость?", "pricing"],
  ["Здравствуйте", "other"],
]) {
  test(`returns ready for ${topic}`, async () => {
    assert.deepEqual(await post(JSON.stringify({ text })), {
      status: 200,
      body: { status: "ready", topic, draft },
    });
  });
}

for (const marker of ["timeout", "error", "bad-json", "bad-topic", "empty-draft"]) {
  test(`requires manual review for [${marker}] and recovers`, async () => {
    const start = performance.now();
    const response = await post(JSON.stringify({ text: `[${marker}]` }));
    const elapsed = performance.now() - start;
    assert.deepEqual(response, {
      status: 200,
      body: { status: "manual_review", topic: null, draft: null },
    });
    if (marker === "timeout") {
      // Allow scheduling overhead, but never wait for the simulator's 1,200 ms delay.
      assert.ok(elapsed < 1_000, `Timeout response took ${elapsed.toFixed(0)} ms`);
    }
    assert.deepEqual(await post(JSON.stringify({ text: "Доставка" })), {
      status: 200,
      body: { status: "ready", topic: "delivery", draft },
    });
  });
}
