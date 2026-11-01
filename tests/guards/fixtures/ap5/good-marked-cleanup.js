// AP5 green: a logic path rethrows; a cleanup path says it is cleanup.
export function risky(f, log) {
  try {
    f();
  } catch (err) {
    log.error(err);
    throw err;
  }
}

export function closeQuietly(socket) {
  // cleanup: the socket is already going away; a close error changes nothing.
  socket.close().catch(() => {});
}
