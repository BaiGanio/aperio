import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { getEphemeralPort, primeLlamaCppModel } from "../../bootstrap.js";

const originalPort = process.env.LLAMACPP_PORT;

afterEach(() => {
  if (originalPort === undefined) delete process.env.LLAMACPP_PORT;
  else process.env.LLAMACPP_PORT = originalPort;
});

const listen = (server, port = 0) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", () => resolve(server.address().port));
});

const close = server => new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));

test("ephemeral port picker releases a bindable OS-assigned port", async () => {
  const port = await getEphemeralPort();
  const server = net.createServer();
  try {
    assert.equal(await listen(server, port), port);
  } finally {
    await close(server);
  }
});

test("ephemeral port selection ignores the former LLAMACPP_PORT + 1000 collision", async () => {
  const occupied = net.createServer();
  const oldScratchPort = await listen(occupied);
  process.env.LLAMACPP_PORT = String(oldScratchPort - 1000);
  try {
    const port = await getEphemeralPort();
    assert.notEqual(port, oldScratchPort);
    const probe = net.createServer();
    try {
      assert.equal(await listen(probe, port), port);
    } finally {
      await close(probe);
    }
  } finally {
    await close(occupied);
  }
});

test("model priming retries once with a fresh port and names the final attempted port", async () => {
  const picked = [41001, 41002];
  const attempted = [];
  const error = await primeLlamaCppModel("foo/model:Q4", {
    pickPort: async () => picked.shift(),
    primeOnPort: async (_model, port) => {
      attempted.push(port);
      throw new Error("bind race");
    },
  }).catch(err => err);

  assert.deepEqual(attempted, [41001, 41002]);
  assert.match(error.message, /port 41002/);
  assert.match(error.message, /bind race/);
});
