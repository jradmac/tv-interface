// dshost: a tiny libretro frontend for the TV box's DS player.
// It runs one DS core with no window. The tv-server starts it and talks over pipes:
//   stdin  : text commands, one per line (buttons, touch, save/load state, pause, quit)
//   stdout : binary messages  [u8 type][u8 0][u16 arg][u32 len][payload]
//            1 = top screen    256x192 RGB565 (every drawn frame)
//            2 = audio         int16 stereo, arg = sample rate / 100
//            3 = event         JSON text, one object
//            4 = bottom screen 256x192 RGB565 (only when it changed)
// Usage: dshost <core.so> <rom> <save dir> [state to load] [auto-save state written on exit]
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include <zlib.h>
#include "libretro.h"

#define SW 256
#define SH 192

static void (*core_init)(void), (*core_deinit)(void), (*core_run)(void), (*core_reset)(void);
static void (*core_set_env)(retro_environment_t), (*core_set_video)(retro_video_refresh_t);
static void (*core_set_audio)(retro_audio_sample_t), (*core_set_audio_batch)(retro_audio_sample_batch_t);
static void (*core_set_poll)(retro_input_poll_t), (*core_set_state)(retro_input_state_t);
static bool (*core_load)(const struct retro_game_info *);
static void (*core_unload)(void), (*core_av)(struct retro_system_av_info *);
static size_t (*core_ser_size)(void);
static bool (*core_ser)(void *, size_t), (*core_unser)(const void *, size_t);

static const char *save_dir = ".", *sys_dir = ".";
static int pixfmt = RETRO_PIXEL_FORMAT_0RGB1555;
static volatile sig_atomic_t want_quit = 0;
static FILE *po;                    // the protocol stream (the real stdout)
static uint16_t btn = 0;            // libretro joypad bitmask
static int touch_x = -1, touch_y = -1;
static int frameskip = 0, fs_changed = 0;
static uint16_t top[SW * SH], bot[SW * SH], lastbot[SW * SH];
static int have_lastbot = 0, force_bot = 1;
static int16_t abuf[4096 * 2];
static size_t an = 0;
static double rate = 44100;

static void out(uint8_t type, uint16_t arg, const void *p, uint32_t len) {
  uint8_t h[8] = { type, 0, arg & 255, arg >> 8, len & 255, (len >> 8) & 255, (len >> 16) & 255, len >> 24 };
  if (fwrite(h, 1, 8, po) != 8 || (len && fwrite(p, 1, len, po) != len)) want_quit = 1;
}
static void event(const char *fmt, ...) {
  char b[1024]; va_list ap; va_start(ap, fmt);
  int n = vsnprintf(b, sizeof b, fmt, ap); va_end(ap);
  if (n > 0) { out(3, 0, b, n < (int)sizeof b ? n : (int)sizeof b - 1); fflush(po); }
}

static void core_log(enum retro_log_level lvl, const char *fmt, ...) {
  if (lvl < RETRO_LOG_WARN) return;
  va_list ap; va_start(ap, fmt); vfprintf(stderr, fmt, ap); va_end(ap);
}

// Core options. Only what we care about; the core uses its defaults for the rest.
static const char *opt(const char *k) {
  static char fs[4];
  if (!strcmp(k, "desmume_frameskip")) { snprintf(fs, sizeof fs, "%d", frameskip); return fs; }
  static const char *kv[][2] = {
    { "desmume_cpu_mode", "jit" }, { "desmume_jit_block_size", "100" },
    { "desmume_screens_layout", "top/bottom" }, { "desmume_screens_gap", "0" },
    { "desmume_internal_resolution", "256x192" }, { "desmume_color_depth", "16-bit" },
    { "desmume_pointer_mouse", "enabled" }, { "desmume_pointer_type", "touch" },
    { "desmume_pointer_device_l", "none" }, { "desmume_pointer_device_r", "none" },
    { "desmume_pointer_colour", "none" },
    { "desmume_num_cores", "2" }, { "desmume_advanced_timing", "disabled" },
    { "desmume_load_to_memory", "enabled" }, { "desmume_firmware_language", "English" },
    { "desmume_use_external_bios", "disabled" }, { "desmume_boot_into_bios", "disabled" },
    { "desmume_gfx_edgemark", "enabled" }, { "desmume_gfx_linehack", "enabled" },
    { "desmume_gfx_txthack", "disabled" }, { "desmume_mic_mode", "internal" },
    { "desmume_input_rotation", "0" }, { "desmume_hybrid_showboth_screens", "enabled" },
  };
  for (size_t i = 0; i < sizeof kv / sizeof kv[0]; i++) if (!strcmp(k, kv[i][0])) return kv[i][1];
  return NULL;
}

static bool env(unsigned cmd, void *data) {
  switch (cmd) {
  case RETRO_ENVIRONMENT_GET_LOG_INTERFACE: ((struct retro_log_callback *)data)->log = core_log; return true;
  case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY: *(const char **)data = sys_dir; return true;
  case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY: *(const char **)data = save_dir; return true;
  case RETRO_ENVIRONMENT_GET_CAN_DUPE: *(bool *)data = true; return true;
  case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS: return true;
  case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: {
    int f = *(const int *)data;
    if (f == RETRO_PIXEL_FORMAT_RGB565 || f == RETRO_PIXEL_FORMAT_XRGB8888) { pixfmt = f; return true; }
    return false;
  }
  case RETRO_ENVIRONMENT_GET_VARIABLE: {
    struct retro_variable *v = data; v->value = opt(v->key); return v->value != NULL;
  }
  case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE: *(bool *)data = fs_changed; fs_changed = 0; return true;
  case RETRO_ENVIRONMENT_SET_VARIABLES: case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
  case RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL: case RETRO_ENVIRONMENT_SET_MESSAGE:
  case RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS: case RETRO_ENVIRONMENT_SET_GEOMETRY:
  case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
    return true;
  default: return false;
  }
}

static void copy_screen(uint16_t *dst, const void *src, unsigned y0, size_t pitch) {
  for (unsigned y = 0; y < SH; y++) {
    const uint8_t *row = (const uint8_t *)src + (y0 + y) * pitch;
    if (pixfmt == RETRO_PIXEL_FORMAT_RGB565) memcpy(dst + y * SW, row, SW * 2);
    else {
      const uint32_t *p = (const uint32_t *)row; uint16_t *d = dst + y * SW;
      for (unsigned x = 0; x < SW; x++) { uint32_t c = p[x]; d[x] = ((c >> 8) & 0xF800) | ((c >> 5) & 0x07E0) | ((c >> 3) & 0x1F); }
    }
  }
}
static void video(const void *data, unsigned w, unsigned h, size_t pitch) {
  if (!data || w < SW || h < SH * 2) return;   // a duped or skipped frame
  copy_screen(top, data, 0, pitch);
  copy_screen(bot, data, SH, pitch);
  out(1, 0, top, sizeof top);
  if (force_bot || !have_lastbot || memcmp(bot, lastbot, sizeof bot)) {
    out(4, 0, bot, sizeof bot); memcpy(lastbot, bot, sizeof bot); have_lastbot = 1; force_bot = 0;
  }
}
static size_t audio_batch(const int16_t *d, size_t frames) {
  size_t room = sizeof abuf / 4 - an; if (frames > room) frames = room;
  memcpy(abuf + an * 2, d, frames * 4); an += frames; return frames;
}
static void audio_one(int16_t l, int16_t r) { int16_t s[2] = { l, r }; audio_batch(s, 1); }
static void poll_cb(void) {}
static int16_t state_cb(unsigned port, unsigned dev, unsigned idx, unsigned id) {
  if (port) return 0;
  if (getenv("DSHOST_DEBUG") && dev != RETRO_DEVICE_JOYPAD) fprintf(stderr, "in dev=%u id=%u t=%d,%d\n", dev, id, touch_x, touch_y);
  if (dev == RETRO_DEVICE_JOYPAD) return id == RETRO_DEVICE_ID_JOYPAD_MASK ? btn : (btn >> id) & 1;
  if (dev == RETRO_DEVICE_POINTER) {
    if (touch_x < 0) return 0;
    if (id == RETRO_DEVICE_ID_POINTER_PRESSED) return 1;
    // The core's screen is 256x384 (top over bottom); the touch area is the lower half.
    if (id == RETRO_DEVICE_ID_POINTER_X) return (int16_t)((touch_x * 2 + 1) * 0x10000 / (SW * 2) - 0x8000);
    if (id == RETRO_DEVICE_ID_POINTER_Y) return (int16_t)(((SH + touch_y) * 2 + 1) * 0x10000 / (SH * 4) - 0x8000);
  }
  return 0;
}

// Save states are gzip files (a raw DS state is 12 MB; packed it is about 2 MB).
static void save_state(const char *path) {
  size_t n = core_ser_size(); void *b = malloc(n);
  char tmp[4200]; snprintf(tmp, sizeof tmp, "%s.tmp", path);
  int ok = 0;
  if (b && core_ser(b, n)) {
    gzFile g = gzopen(tmp, "wb1");
    if (g) { ok = gzwrite(g, b, n) == (int)n; ok = (gzclose(g) == Z_OK) && ok; }
    if (ok) { int fd = open(tmp, O_RDONLY); if (fd >= 0) { fsync(fd); close(fd); } ok = rename(tmp, path) == 0; }
    else unlink(tmp);
  }
  if (ok) event("{\"ev\":\"saved\"}"); else event("{\"ev\":\"error\",\"what\":\"save\"}");
  free(b);
}
static void load_state(const char *path) {
  size_t n = core_ser_size(); void *b = malloc(n); int ok = 0;
  gzFile g = gzopen(path, "rb");   // also reads a plain, unpacked state
  if (g && b) { ok = gzread(g, b, n) == (int)n; }
  if (g) gzclose(g);
  if (ok && core_unser(b, n)) { force_bot = 1; event("{\"ev\":\"loaded\"}"); }
  else event("{\"ev\":\"error\",\"what\":\"load\"}");
  free(b);
}

static int paused = 0, ff = 0;
static char inbuf[8192]; static size_t inlen = 0;
static void command(char *l) {
  if (getenv("DSHOST_DEBUG")) fprintf(stderr, "cmd [%s]\n", l);
  if (!strncmp(l, "b ", 2)) btn = (uint16_t)strtoul(l + 2, 0, 10);
  else if (!strncmp(l, "t ", 2)) {
    int x = -1, y = -1; sscanf(l + 2, "%d %d", &x, &y);
    if (x < 0 || y < 0) touch_x = touch_y = -1;
    else { touch_x = x > SW - 1 ? SW - 1 : x; touch_y = y > SH - 1 ? SH - 1 : y; }
  }
  else if (!strncmp(l, "save ", 5)) save_state(l + 5);
  else if (!strncmp(l, "load ", 5)) load_state(l + 5);
  else if (!strncmp(l, "pause ", 6)) { paused = atoi(l + 6); event("{\"ev\":\"paused\",\"on\":%d}", paused); }
  else if (!strncmp(l, "ff ", 3)) ff = atoi(l + 3);
  else if (!strcmp(l, "reset")) { core_reset(); force_bot = 1; }
  else if (!strcmp(l, "bottom")) force_bot = 1;
  else if (!strcmp(l, "quit")) want_quit = 1;
}
// Reads whatever commands are waiting, without blocking. Returns -1 when the server is gone.
static int read_commands(int timeout_ms) {
  struct pollfd p = { 0, POLLIN, 0 };
  while (poll(&p, 1, timeout_ms) > 0) {
    timeout_ms = 0;
    ssize_t r = read(0, inbuf + inlen, sizeof inbuf - 1 - inlen);
    if (r <= 0) return -1;
    inlen += r; inbuf[inlen] = 0;
    char *s = inbuf, *nl;
    while ((nl = strchr(s, '\n'))) { *nl = 0; command(s); s = nl + 1; }
    inlen -= s - inbuf; memmove(inbuf, s, inlen);
    if (inlen >= sizeof inbuf - 1) inlen = 0;
  }
  return 0;
}

static void on_sig(int s) { (void)s; want_quit = 1; }
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }
#define SYM(v, n) do { *(void **)&v = dlsym(h, n); if (!v) { fprintf(stderr, "core is missing %s\n", n); return 2; } } while (0)

int main(int argc, char **argv) {
  if (argc < 4) { fprintf(stderr, "usage: dshost core.so rom savedir [state]\n"); return 2; }
  save_dir = sys_dir = argv[3];
  signal(SIGTERM, on_sig); signal(SIGINT, on_sig); signal(SIGHUP, on_sig); signal(SIGPIPE, SIG_IGN);
  // The core prints its own chatter with printf: send that to stderr and keep stdout for frames.
  po = fdopen(dup(1), "wb"); dup2(2, 1);
  static char obuf[1 << 18]; setvbuf(po, obuf, _IOFBF, sizeof obuf);
  void *h = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (!h) { fprintf(stderr, "%s\n", dlerror()); return 2; }
  SYM(core_init, "retro_init"); SYM(core_deinit, "retro_deinit"); SYM(core_run, "retro_run");
  SYM(core_reset, "retro_reset"); SYM(core_set_env, "retro_set_environment");
  SYM(core_set_video, "retro_set_video_refresh"); SYM(core_set_audio, "retro_set_audio_sample");
  SYM(core_set_audio_batch, "retro_set_audio_sample_batch"); SYM(core_set_poll, "retro_set_input_poll");
  SYM(core_set_state, "retro_set_input_state"); SYM(core_load, "retro_load_game");
  SYM(core_unload, "retro_unload_game"); SYM(core_av, "retro_get_system_av_info");
  SYM(core_ser_size, "retro_serialize_size"); SYM(core_ser, "retro_serialize"); SYM(core_unser, "retro_unserialize");

  core_set_env(env); core_init();
  core_set_video(video); core_set_audio(audio_one); core_set_audio_batch(audio_batch);
  core_set_poll(poll_cb); core_set_state(state_cb);
  struct retro_game_info gi = { argv[2], NULL, 0, NULL };
  if (!core_load(&gi)) { event("{\"ev\":\"error\",\"what\":\"rom\"}"); return 3; }
  struct retro_system_av_info av; memset(&av, 0, sizeof av); core_av(&av);
  double fps = av.timing.fps > 1 ? av.timing.fps : 59.8261; if (av.timing.sample_rate > 1000) rate = av.timing.sample_rate;
  if (argc > 4 && argv[4][0]) load_state(argv[4]);
  event("{\"ev\":\"ready\",\"fps\":%.4f,\"rate\":%.0f}", fps, rate);

  const double period = 1.0 / fps;
  double next = now(), busy = 0, report = now() + 5; int frames = 0, drawn_skips = 0;
  while (!want_quit) {
    if (read_commands(0) < 0) break;
    if (paused) { fflush(po); if (read_commands(100) < 0) break; next = now(); continue; }
    double t0 = now();
    int runs = ff ? 3 : 1;
    for (int i = 0; i < runs; i++) core_run();
    double dt = now() - t0;
    busy = busy * 0.95 + dt / runs * 0.05;
    if (an) { if (!ff) out(2, (uint16_t)(rate / 100), abuf, an * 4); an = 0; }
    fflush(po);
    frames++;
    // Auto frame skip: draw every other frame only while the box can't keep up.
    if (!frameskip && busy > period * 0.92) { frameskip = 1; fs_changed = 1; drawn_skips++; }
    else if (frameskip && busy < period * 0.55) { frameskip = 0; fs_changed = 1; }
    next += period;
    double wait = next - now();
    if (wait < -0.1) next = now();        // fell far behind: don't try to catch up
    else if (wait > 0) {
      // Sleep in small steps so new buttons and touches are picked up quickly.
      while ((wait = next - now()) > 0.0005) if (read_commands(wait > 0.004 ? 3 : 0) < 0) { want_quit = 1; break; }
    }
    if (now() > report) {
      event("{\"ev\":\"perf\",\"frame_ms\":%.2f,\"skip\":%d}", busy * 1000, frameskip);
      report = now() + 5;
    }
  }
  // Leaving the game (Home, a box restart, an update) always keeps a resume point.
  if (argc > 5 && argv[5][0] && frames > 60) save_state(argv[5]);
  core_unload();   // writes the in-game save (.dsv)
  core_deinit();
  event("{\"ev\":\"bye\"}");
  return 0;
}
