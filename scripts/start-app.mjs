#!/usr/bin/env node
// `npm start` - load config, start the app, close it in reverse on SIGINT /
// SIGTERM (spec S2.14 §2.5). All the work is in src/boot/start-server.js.

import process from 'node:process';
import { loadConfig } from '../src/config/load-config.js';
import { startServer } from '../src/boot/start-server.js';

const config = await loadConfig();
const app = await startServer({ config: config.values });

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.info(`[start] ${signal}: closing`);
  try {
    await app.stop();
    process.exitCode = 0;
  } catch (err) {
    console.error(`[start] close failed: ${err.message}`);
    process.exitCode = 1;
  }
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
