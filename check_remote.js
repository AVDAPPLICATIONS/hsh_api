const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.exec('ls -la /home/u562700164/domains/attendentsnews.hpys.in/hbuilds/current/nodejs/node_modules/axios/dist/node', (err, stream) => {
    if (err) throw err;
    stream.on('data', d => process.stdout.write(d.toString()));
    stream.stderr.on('data', d => process.stderr.write(d.toString()));
    stream.on('close', () => conn.end());
  });
}).connect({
  host: '82.180.143.125',
  port: 65002,
  username: 'u562700164',
  password: 'Guruhari@1723'
});
