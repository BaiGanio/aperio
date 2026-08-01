import { parentPort } from "node:worker_threads";

parentPort.once("message", () => process.exit(0));
