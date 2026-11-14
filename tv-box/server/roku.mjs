// The TV itself (a Roku TV, e.g. TCL), controlled over Wi-Fi with Roku's External Control
// Protocol on port 8060: power on/off, switch to the box's HDMI input, read the power state.
// Found with SSDP (ST: roku:ecp) or by an IP typed on the phone. No npm packages.
//
// Needs, on the TV: Settings > System > Advanced system settings > Control by mobile apps =
// Enabled (or Permissive), and Settings > System > Power > Fast TV Start = on (so it hears
// "PowerOn" while asleep).

import dgram from 'node:dgram';

const PORT = 8060;
const HINT_ECP = 'On the TV: Settings → System → Advanced system settings → Control by mobile apps → Network access → Enabled';
const HINT_ASLEEP = "The TV didn't answer. To turn it on from the phone, Fast TV start must be on (Settings → System → Power → Fast TV start)";
const HINT_NOT_FOUND = "Couldn't find the TV on Wi-Fi. Make sure it's on, or type its IP (TV Settings → Network → About)";

export class Roku {
  // cfg: { ip, hdmi, name } saved by the caller; onChange(status) is called on every change.
  constructor(cfg, { save, onChange, log = () => {}, discoverMs = 3000, base } = {}) {
    this.cfg = cfg;               // mutated + saved
    this.save = save || (() => {});
    this.onChange = onChange || (() => {});
    this.log = log;
    this.discoverMs = discoverMs;
    this.base = base;             // tests: 'http://127.0.0.1:18060' instead of http://ip:8060
    this.st = { found: false, name: cfg.name || '', on: null, hdmi: cfg.hdmi || 1, busy: false, hint: '' };
    if (!cfg.hdmi) cfg.hdmi = 1;  // Jared's box is on HDMI 1
    this.timer = null;
  }

  status() { return { t: 'tv.status', ...this.st }; }
  set(p) {
    const before = JSON.stringify(this.st);
    Object.assign(this.st, p);
    if (JSON.stringify(this.st) !== before) this.onChange(this.status());
  }
  url(p) { return (this.base || `http://${this.cfg.ip}:${PORT}`) + p; }

  start() {
    this.refresh(true);
    this.timer = setInterval(() => this.refresh(false), 15000);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); }

  async req(method, p, ms = 2500) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(this.url(p), { method, signal: ac.signal, headers: method === 'POST' ? { 'content-length': '0' } : {} });
      return { status: r.status, text: await r.text() };
    } finally { clearTimeout(t); }
  }

  // device-info: <power-mode>PowerOn|DisplayOff|Ready|Headless</power-mode>, names, is-tv.
  async info() {
    const r = await this.req('GET', '/query/device-info');
    if (r.status === 403) { const e = new Error('ecp-off'); e.code = 403; throw e; }
    if (r.status !== 200) throw new Error('device-info ' + r.status);
    const tag = (n) => (r.text.match(new RegExp(`<${n}>([^<]*)</${n}>`)) || [])[1] || '';
    return {
      on: tag('power-mode') ? tag('power-mode') === 'PowerOn' : null,
      name: tag('user-device-name') || tag('friendly-device-name') || tag('model-name') || 'TV',
      isTv: tag('is-tv') !== 'false',
    };
  }

  async activeInput() {
    const r = await this.req('GET', '/query/active-app').catch(() => null);
    const m = r && r.text.match(/id="tvinput\.hdmi(\d)"/);
    return m ? Number(m[1]) : null;
  }

  // Find the TV: the saved IP first, then SSDP. Called at start, every 15 s, and on setup.
  async refresh(search) {
    if (this.cfg.ip || this.base) {
      try {
        const i = await this.info();
        if (i.name !== this.cfg.name) { this.cfg.name = i.name; this.save(); }
        const hint = this.st.hint === HINT_ECP || this.st.hint === HINT_NOT_FOUND ? '' : this.st.hint;
        return this.set({ found: true, name: i.name, on: i.on, hint });
      } catch (e) {
        if (e.code === 403) return this.set({ found: true, on: null, hint: HINT_ECP });
        // Asleep without Fast TV Start, or the IP changed: look again.
        if (!search) return this.set({ on: this.st.found ? false : null });
      }
    }
    if (!search) return;
    const ip = await this.discover();
    if (ip) {
      if (ip !== this.cfg.ip) { this.cfg.ip = ip; this.save(); this.log('roku found at', ip); }
      return this.refresh(false);
    }
    this.set({ found: false, on: null, hint: this.cfg.ip ? HINT_ASLEEP : HINT_NOT_FOUND });
  }

  discover() {
    if (this.base) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const finish = (ip) => { if (done) return; done = true; try { sock.close(); } catch {} resolve(ip); };
      sock.on('error', () => finish(null));
      sock.on('message', (buf) => {
        const s = buf.toString();
        if (!/roku:ecp/i.test(s)) return;
        const m = s.match(/LOCATION:\s*http:\/\/([\d.]+):8060/i);
        if (m) finish(m[1]);
      });
      const msg = Buffer.from('M-SEARCH * HTTP/1.1\r\nHost: 239.255.255.250:1900\r\nMan: "ssdp:discover"\r\nST: roku:ecp\r\nMX: 2\r\n\r\n');
      sock.bind(0, () => {
        const send = () => sock.send(msg, 1900, '239.255.255.250', () => {});
        send(); setTimeout(send, 600);
      });
      setTimeout(() => finish(null), this.discoverMs);
    });
  }

  async key(k) {
    const r = await this.req('POST', '/keypress/' + k, 4000);
    if (r.status === 403) { const e = new Error('ecp-off'); e.code = 403; throw e; }
    if (r.status >= 300) throw new Error(k + ' ' + r.status);
  }

  // on: true | false | undefined (toggle). Power on also switches to the box's HDMI input.
  async power(on) {
    if (this.st.busy) return;
    if (!this.st.found && !this.cfg.ip) await this.refresh(true);
    if (!this.st.found && !this.cfg.ip) return;
    if (on === undefined || on === null) on = this.st.on === false || this.st.on === null ? true : false;
    this.set({ busy: true });
    try {
      if (!on) {
        await this.key('PowerOff');
        this.set({ on: false, hint: '' });
      } else {
        await this.key('PowerOn');
        this.set({ on: true, hint: '' });
        // The TV takes a moment to wake before it takes the input switch. Try a few times.
        const n = this.cfg.hdmi || 1;
        for (let i = 0; i < 4; i++) {
          await sleep(i === 0 ? 1500 : 1500);
          try { await this.key('InputHDMI' + n); } catch { continue; }
          if (this.base || (await this.activeInput()) === n) break;
        }
      }
    } catch (e) {
      this.log('roku power', e.message);
      this.set({ hint: e.code === 403 ? HINT_ECP : HINT_ASLEEP });
    } finally {
      this.set({ busy: false });
      setTimeout(() => this.refresh(false), 4000).unref?.();
    }
  }

  async setup({ ip, hdmi }) {
    if (hdmi !== undefined) {
      const n = Number(hdmi);
      if (n >= 1 && n <= 4 && n !== this.cfg.hdmi) { this.cfg.hdmi = n; this.save(); this.set({ hdmi: n }); }
    }
    if (ip !== undefined) {
      const s = String(ip).trim();
      if (s === '') { delete this.cfg.ip; this.save(); return this.refresh(true); }
      // Only a private LAN address: this must never become a way to make the box call out.
      if (!/^(192\.168|10|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(\.\d{1,3})?$/.test(s) || s.split('.').length !== 4) return this.set({ hint: 'That doesn\'t look like a TV address (like 192.168.0.50)' });
      this.cfg.ip = s; this.save();
      return this.refresh(false).then(() => { if (!this.st.found) this.set({ hint: HINT_NOT_FOUND }); });
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
