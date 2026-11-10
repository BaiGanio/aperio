// src/eval/sandbox.js — one isolated temp root per run (spec S2.1 "Limits";
// L-M16, L-P02). The root holds the workdir, the scratch DB path and a
// record of the port. The port is held open by a placeholder listener for
// the life of the sandbox, so two runs can never get the same one; the
// target calls releasePort() just before it binds. Everything is torn down
// on success and on a throw.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

/** Bind an OS-chosen free port that is not one of the default ports. */
async function holdFreePort(defaultPorts) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const server = createServer();
    const port = await new Promise((ok, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => ok(server.address().port));
    });
    if (!defaultPorts.includes(port)) return { server, port };
    await new Promise((ok) => server.close(ok));
  }
  throw new Error('eval sandbox: no free non-default port after 20 tries');
}

/**
 * @template T
 * @param {{tmpBase: string, defaultPorts: readonly number[]}} settings
 * @param {(box: {root: string, workdir: string, dbPath: string, portFile: string, port: number,
 *   allowedPaths: string[], releasePort: () => Promise<void>}) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withRunSandbox(settings, fn) {
  const root = await mkdtemp(join(resolve(settings.tmpBase), 'aperio-eval-'));
  let held = null;
  const releasePort = async () => {
    if (!held) return;
    const server = held;
    held = null;
    await new Promise((ok) => server.close(ok));
  };
  try {
    const workdir = join(root, 'work');
    const dbDir = join(root, 'db');
    await mkdir(workdir);
    await mkdir(dbDir);
    const { server, port } = await holdFreePort(settings.defaultPorts);
    held = server;
    const portFile = join(root, 'port');
    await writeFile(portFile, `${port}\n`);
    return await fn({
      root,
      workdir,
      dbPath: join(dbDir, 'eval.sqlite'),
      portFile,
      port,
      allowedPaths: [workdir],
      releasePort,
    });
  } finally {
    await releasePort();
    await rm(root, { recursive: true, force: true });
  }
}
