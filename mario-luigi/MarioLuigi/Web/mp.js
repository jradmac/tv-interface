// DS wireless play over the TV box. Mirrors melonDS's LAN mode (src/net/LAN.cpp) so games see the same timing:
// a receive queue where packets older than 16 ms are stale, and waits of up to 25 ms for the host's frame or
// the clients' replies. Packets travel as binary WebSocket messages through the box, which only forwards them.
// Wire format (little endian): u32 to (0xFFFFFFFF = everyone), u32 from, u32 type (low 16 bits: 0 data,
// 1 host cmd, 2 reply, 3 ack; high 16 bits: reply AID), u32 len, f64 timestamp, then len bytes.
(function (root) {
  const HDR = 24, STALE = 16, WAIT = 25;
  function createMP(opts) {
    // Wi-Fi is slower than a cable: the host waits only replyWait ms for replies before going on, and accepts a
    // reply that comes in late (up to replySlack µs of DS time old) at the next exchange. That keeps the race at
    // full speed when the phones are a few ms apart; the game treats a late reply like a normal wireless retry.
    const replyWait = opts.replyWait != null ? opts.replyWait : WAIT, replySlack = opts.replySlack != null ? opts.replySlack : 32;
    // opts.send(arrayBuffer) sends to the box; call mp.onPacket(arrayBuffer) / mp.setRoster({me, connected}) on input.
    const now = opts.now || (() => performance.now());
    const mp = { me: 0, connected: 0, lastHost: -1, inbox: [], queue: [], waiter: null, heap: null, stats: { tx: 0, rx: 0, waits: 0, timeouts: 0, waitMs: 0 } };
    mp.setHeap = (m) => { mp.m = m; };
    mp.begin = () => { opts.control({ t: 'mp', on: true }); };
    mp.end = () => { opts.control({ t: 'mp', on: false }); };
    mp.setRoster = (r) => { if (r.me != null) mp.me = r.me; if (r.connected != null) mp.connected = r.connected; };
    mp.send = (type, bytes, ts, aid) => {
      const len = bytes.length, buf = new ArrayBuffer(HDR + len), dv = new DataView(buf);
      const to = type === 2 && mp.lastHost >= 0 ? mp.lastHost : 0xFFFFFFFF;
      dv.setUint32(0, to, true); dv.setUint32(4, mp.me, true); dv.setUint32(8, (type & 0xFFFF) | ((aid & 0xFFFF) << 16), true);
      dv.setUint32(12, len, true); dv.setFloat64(16, ts, true); new Uint8Array(buf, HDR).set(bytes);
      opts.send(buf); mp.stats.tx++;
      return len;
    };
    mp.onPacket = (buf) => {
      const dv = new DataView(buf);
      if (buf.byteLength < HDR) return;
      const p = { from: dv.getUint32(4, true), type: dv.getUint32(8, true), len: dv.getUint32(12, true), ts: dv.getFloat64(16, true), data: new Uint8Array(buf, HDR) };
      if (p.from === mp.me) return;
      mp.inbox.push(p); mp.stats.rx++;
      if (mp.waiter) { const w = mp.waiter; mp.waiter = null; w(); }
    };
    function takeOne() { const p = mp.inbox.shift(); p.rx = now(); mp.queue.push(p); }
    function dropStale() {
      const t = now();
      while (mp.queue.length && t - mp.queue[0].rx > STALE) mp.queue.shift();
    }
    // LAN::ProcessLAN. type 0: housekeeping, 1: non-blocking (regular frames), 2: blocking (MP frames)
    async function processLAN(type, wait = WAIT) {
      dropStale();
      if (mp.queue.length) {
        if (type === 2) return;
        if (type === 1) { if ((mp.queue[0].type & 0xFFFF) === 0) return; mp.queue.shift(); }
      }
      if (mp.inbox.length) { takeOne(); return; }
      if (type !== 2 || wait <= 0) return;
      const t0 = now(); mp.stats.waits++;
      await new Promise((res) => { const timer = setTimeout(() => { mp.waiter = null; res(); }, wait); mp.waiter = () => { clearTimeout(timer); res(); }; });
      mp.stats.waitMs += now() - t0;
      if (mp.inbox.length) takeOne(); else mp.stats.timeouts++;
    }
    function copyOut(p, ptr, max, tsPtr) {
      const len = Math.min(p.len, max);
      if (len) mp.m.HEAPU8.set(p.data.subarray(0, len), ptr);
      if (tsPtr) mp.m.HEAPF64[tsPtr >> 3] = p.ts;
      return len;
    }
    function popPacket(ptr, tsPtr) {
      if (!mp.queue.length) return 0;
      const p = mp.queue.shift();
      if (p.len && (p.type & 0xFFFF) === 1) mp.lastHost = p.from;
      return copyOut(p, ptr, 2048, tsPtr);
    }
    // Non-blocking receive (RecvPacket). processLAN(1) never awaits, so run its sync path inline.
    mp.recvNow = (ptr, tsPtr) => {
      dropStale();
      let skip = false;
      if (mp.queue.length) { if ((mp.queue[0].type & 0xFFFF) === 0) skip = true; else mp.queue.shift(); }
      if (!skip && mp.inbox.length) takeOne();
      return popPacket(ptr, tsPtr);
    };
    mp.recvHost = async (ptr, tsPtr) => {
      if (mp.lastHost !== -1 && !(mp.connected & (1 << mp.lastHost))) return -1;
      await processLAN(2);
      return popPacket(ptr, tsPtr);
    };
    mp.recvReplies = async (ptr, ts, aidmask) => {
      let ret = 0, mine = 1 << mp.me;
      if ((mine & mp.connected) === mp.connected) return 0;
      const t0 = now();
      for (;;) {
        await processLAN(2, Math.max(0, replyWait - (now() - t0)));
        if (!mp.queue.length) return ret;
        const p = mp.queue.shift();
        if ((p.type & 0xFFFF) === 2 && p.ts >= ts - replySlack) {
          const len = Math.min(p.len, 1024), aid = p.type >>> 16;
          if (len && aid >= 1) { mp.m.HEAPU8.set(p.data.subarray(0, len), ptr + (aid - 1) * 1024); ret |= 1 << aid; }
          mine |= 1 << p.from;
          if ((mine & mp.connected) === mp.connected || (ret & aidmask) === aidmask) return ret;
        }
      }
    };
    return mp;
  }
  root.createMP = createMP;
  if (typeof module !== 'undefined') module.exports = { createMP };
})(typeof window !== 'undefined' ? window : globalThis);
