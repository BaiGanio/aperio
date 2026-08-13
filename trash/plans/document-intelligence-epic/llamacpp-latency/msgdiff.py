#!/usr/bin/env python3
"""Diff consecutive llama.cpp msgprint lines to find where the KV prefix breaks.

Reads a harness log, pairs each `msgprint req=N` with its `fingerprint req=N`,
and for each consecutive pair of requests reports the first message index whose
hash differs -- i.e. the point past which llama-server cannot reuse the cache.
"""
import re
import sys

log = open(sys.argv[1], errors="replace").read().splitlines()

fp = {}
mp = {}
for line in log:
    m = re.search(r"fingerprint req=(\d+) noTools=(\d) sysBytes=(\d+) sysHash=(\w+) "
                  r"toolsBytes=(\d+) toolsHash=(\w+) toolCount=(\d+) msgCount=(\d+)", line)
    if m:
        fp[int(m.group(1))] = dict(noTools=m.group(2), sysHash=m.group(4),
                                   toolsHash=m.group(6), toolCount=m.group(7),
                                   msgCount=int(m.group(8)))
    m = re.search(r"msgprint req=(\d+) (.*)$", line)
    if m:
        msgs = []
        for tok in m.group(2).split():
            parts = tok.split(":")
            if len(parts) == 4:
                msgs.append((parts[1], parts[2], int(parts[3])))  # role, hash, bytes
        mp[int(m.group(1))] = msgs

seqs = sorted(mp)
print(f"requests captured: {len(seqs)}\n")

prev = None
for s in seqs:
    f = fp.get(s, {})
    cur = mp[s]
    total = sum(b for _, _, b in cur)
    head = (f"req={s:<3} msgs={len(cur):<3} bytes={total:<7} "
            f"noTools={f.get('noTools','?')} tools={f.get('toolCount','?')} "
            f"sys={f.get('sysHash','?')[:6]} toolsH={f.get('toolsHash','?')[:6]}")
    if prev is None:
        print(head + "  (first)")
    else:
        pseq, pmsgs = prev
        n = min(len(pmsgs), len(cur))
        first = next((i for i in range(n) if pmsgs[i][1] != cur[i][1]), None)
        if first is None and len(pmsgs) == len(cur):
            print(head + f"  identical to req={pseq}")
        elif first is None:
            print(head + f"  pure append after req={pseq} (+{len(cur)-len(pmsgs)} msgs) -- prefix intact")
        else:
            reusable = sum(b for _, _, b in cur[:first])
            print(head + f"  DIVERGES at index {first} vs req={pseq}"
                         f"  (prefix kept: {first} msgs / {reusable} bytes)")
            pr, ph, pb = pmsgs[first]
            cr, ch, cb = cur[first]
            print(f"       idx {first}: {pr} {ph} {pb}B  ->  {cr} {ch} {cb}B  (delta {cb-pb:+}B)")
            # was the old message still present later (i.e. it moved)?
            moved = [i for i in range(len(cur)) if cur[i][1] == ph]
            if moved:
                print(f"       old msg {ph} reappears at index {moved} -- it MOVED, not changed")
    prev = (s, cur)
