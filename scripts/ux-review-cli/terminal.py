"""Run a fixture command in a real terminal; no dependency on util-linux script."""
import errno
import fcntl
import os
import pty
import struct
import sys
import termios

width = int(sys.argv[1])
pid, master = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 24, width, 0, 0))
    os.execvp(sys.argv[2], sys.argv[2:])
while True:
    try:
        data = os.read(master, 65536)
        if not data:
            break
        sys.stdout.buffer.write(data)
    except OSError as error:
        if error.errno != errno.EIO:
            raise
        break
os.close(master)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
