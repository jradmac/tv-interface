#!/usr/bin/env python3
# Runs a command in a pseudo-terminal for termd.mjs.
#   stdin  -> keys for the terminal
#   stdout <- what the terminal shows
#   fd 3   <- "cols rows" lines to resize it
import os, pty, sys, select, fcntl, termios, struct, signal

def size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])

size(fd, int(os.environ.get('COLS', '100')), int(os.environ.get('ROWS', '30')))
signal.signal(signal.SIGTERM, lambda *a: (os.kill(pid, signal.SIGHUP), sys.exit(0)))
ctrl = b''
watch = [0, fd, 3]
while True:
    try:
        r, _, _ = select.select(watch, [], [])
    except InterruptedError:
        continue
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b''
        if not data:
            break
        os.write(1, data)
    if 0 in r:
        data = os.read(0, 65536)
        if not data:
            watch.remove(0)
        else:
            os.write(fd, data)
    if 3 in r:
        data = os.read(3, 4096)
        if not data:
            watch.remove(3)
        ctrl += data
        while b'\n' in ctrl:
            line, ctrl = ctrl.split(b'\n', 1)
            try:
                c, rw = map(int, line.split())
                if 10 <= c <= 500 and 5 <= rw <= 200:
                    size(fd, c, rw)
            except ValueError:
                pass
try:
    os.waitpid(pid, 0)
except OSError:
    pass
