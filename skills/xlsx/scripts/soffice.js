/**
 * Helper for running LibreOffice (soffice) in environments where AF_UNIX
 * sockets may be blocked (e.g., sandboxed VMs). Detects the restriction
 * at runtime and applies an LD_PRELOAD shim if needed.
 *
 * Usage:
 *   import { getSofficeEnv, runSoffice } from "./soffice.js";
 *
 *   const env = getSofficeEnv();
 *   execFile("soffice", [...args], { env });
 */

import { execFileSync } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SHIM_SO  = join(tmpdir(), "lo_socket_shim.so");
const SHIM_SRC = join(tmpdir(), "lo_socket_shim.c");

/**
 * Returns an env object suitable for spawning soffice.
 * On macOS: just sets SAL_USE_VCLPLUGIN=svp.
 * On Linux: additionally applies an LD_PRELOAD shim when AF_UNIX sockets
 * are blocked (detected by whether the shim has already been compiled, or
 * by attempting to compile it now).
 */
export function getSofficeEnv() {
  const env = { ...process.env, SAL_USE_VCLPLUGIN: "svp" };

  if (process.platform === "linux") {
    const shim = _ensureShim();
    if (shim) env.LD_PRELOAD = shim;
  }

  return env;
}

/** Convenience wrapper: runs soffice with the correct env. */
export function runSoffice(args, opts = {}) {
  return execFileSync("soffice", args, { env: getSofficeEnv(), ...opts });
}

// ─── Shim helpers (Linux sandboxes only) ─────────────────────────────────────

function _ensureShim() {
  if (existsSync(SHIM_SO)) return SHIM_SO;

  try {
    writeFileSync(SHIM_SRC, SHIM_SOURCE);
    execFileSync("gcc", ["-shared", "-fPIC", "-o", SHIM_SO, SHIM_SRC, "-ldl"], {
      stdio: "ignore",
    });
    return SHIM_SO;
  } catch {
    return null;
  }
}

// C shim: intercepts AF_UNIX socket() calls that are blocked in sandboxes
// and falls back to a socketpair(). Identical to the Python version's shim.
const SHIM_SOURCE = `
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

static int (*real_socket)(int, int, int);
static int (*real_socketpair)(int, int, int, int[2]);
static int (*real_listen)(int, int);
static int (*real_accept)(int, struct sockaddr *, socklen_t *);
static int (*real_close)(int);
static int (*real_read)(int, void *, size_t);

static int is_shimmed[1024];
static int peer_of[1024];
static int wake_r[1024];
static int wake_w[1024];
static int listener_fd = -1;

__attribute__((constructor))
static void init(void) {
    real_socket     = dlsym(RTLD_NEXT, "socket");
    real_socketpair = dlsym(RTLD_NEXT, "socketpair");
    real_listen     = dlsym(RTLD_NEXT, "listen");
    real_accept     = dlsym(RTLD_NEXT, "accept");
    real_close      = dlsym(RTLD_NEXT, "close");
    real_read       = dlsym(RTLD_NEXT, "read");
    for (int i = 0; i < 1024; i++) {
        peer_of[i] = -1;
        wake_r[i]  = -1;
        wake_w[i]  = -1;
    }
}

int socket(int domain, int type, int protocol) {
    if (domain == AF_UNIX) {
        int fd = real_socket(domain, type, protocol);
        if (fd >= 0) return fd;
        int sv[2];
        if (real_socketpair(domain, type, protocol, sv) == 0) {
            if (sv[0] >= 0 && sv[0] < 1024) {
                is_shimmed[sv[0]] = 1;
                peer_of[sv[0]]    = sv[1];
                int wp[2];
                if (pipe(wp) == 0) {
                    wake_r[sv[0]] = wp[0];
                    wake_w[sv[0]] = wp[1];
                }
            }
            return sv[0];
        }
        errno = EPERM;
        return -1;
    }
    return real_socket(domain, type, protocol);
}

int listen(int sockfd, int backlog) {
    if (sockfd >= 0 && sockfd < 1024 && is_shimmed[sockfd]) {
        listener_fd = sockfd;
        return 0;
    }
    return real_listen(sockfd, backlog);
}

int accept(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
    if (sockfd >= 0 && sockfd < 1024 && is_shimmed[sockfd]) {
        if (wake_r[sockfd] >= 0) {
            char buf;
            real_read(wake_r[sockfd], &buf, 1);
        }
        errno = ECONNABORTED;
        return -1;
    }
    return real_accept(sockfd, addr, addrlen);
}

int close(int fd) {
    if (fd >= 0 && fd < 1024 && is_shimmed[fd]) {
        int was_listener = (fd == listener_fd);
        is_shimmed[fd] = 0;
        if (wake_w[fd] >= 0) {
            char c = 0;
            write(wake_w[fd], &c, 1);
            real_close(wake_w[fd]);
            wake_w[fd] = -1;
        }
        if (wake_r[fd] >= 0) { real_close(wake_r[fd]); wake_r[fd]  = -1; }
        if (peer_of[fd] >= 0) { real_close(peer_of[fd]); peer_of[fd] = -1; }
        if (was_listener) _exit(0);
    }
    return real_close(fd);
}
`;
