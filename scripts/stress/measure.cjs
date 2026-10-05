"use strict";
const { fs } = require("./helpers.cjs");
// GNU time is preferred. Minimal images can still report the same kernel
// ru_maxrss counter with wait4; this is a maximum child RSS, not a sum.
function measurement(file, executable, args) {
  if (fs.existsSync("/usr/bin/time")) return { command: "/usr/bin/time", args: ["-v", "-o", file, executable, ...args], meter: "GNU time -v" };
  const python = `import os,sys,time\nstart=time.monotonic()\npid=os.fork()\nif pid==0:\n os.execv(sys.argv[2],sys.argv[2:])\n_,status,usage=os.wait4(pid,0)\nwith open(sys.argv[1],'w') as out:\n out.write('Maximum resident set size (kbytes): %d\\n' % usage.ru_maxrss)\n out.write('Wall seconds: %.6f\\n' % (time.monotonic()-start))\nsys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128+os.WTERMSIG(status))\n`;
  return { command: "python3", args: ["-c", python, file, executable, ...args], meter: "Python wait4 ru_maxrss (GNU time absent)" };
}
module.exports = { measurement };
