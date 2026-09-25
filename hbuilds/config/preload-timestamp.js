const formatArg = (a) => {
  if (a instanceof Error) return a.stack;
  if (typeof a === 'object' && a !== null) return JSON.stringify(a);
  return String(a);
};

const getStderrLevel = (msg) => /^\(node:\d+\) \w*Warning:/.test(msg) ? 'WARN' : 'ERROR';

const writeLogMsg = (level, msg) =>
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), level, message: msg }) + '\n');

const writeLog = (level, args) => writeLogMsg(level, args.map(formatArg).join(' '));

console.log   = (...args) => writeLog('LOG',   args);
console.error = (...args) => {
  const msg = args.map(formatArg).join(' ');
  writeLogMsg(getStderrLevel(msg), msg);
};
console.warn  = (...args) => writeLog('WARN',  args);
console.info  = (...args) => writeLog('INFO',  args);
console.debug = (...args) => writeLog('DEBUG', args);
console.trace = (...args) => writeLog('TRACE', args);

process.stderr.write = function(chunk, encoding, callback) {
  const msg = chunk.toString().trimEnd();
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level: getStderrLevel(msg), message: msg });
  return process.stdout.write(line + '\n', encoding, callback);
};

process.on('uncaughtExceptionMonitor', (err) => {
  try {
    writeLogMsg('ERROR', err instanceof Error && err.stack ? err.stack : String(err));
  } catch {
    writeLogMsg('ERROR', 'Application crashed with an error that could not be converted to text');
  }
});

if (process.env.LSNODE_SOCKET) {
  setTimeout(() => {
    if (global.LsNode && !global.LsNode.listenDone) {
      writeLogMsg('ERROR',
        'App did not call listen() within 3 seconds. Possible causes: ' +
        '(1) Entry file uses "if (require.main === module)" to guard server.listen() — ' +
        'remove that condition, it is not supported on Hostinger Node.js hosting; ' +
        '(2) App is hanging at startup — check for unresolved promises or blocking calls before listen().'
      );
    }
  }, 3000);
}
