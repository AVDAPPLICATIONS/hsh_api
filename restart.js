const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.exec('touch /home/u562700164/domains/attendentsnews.hpys.in/hbuilds/current/nodejs/tmp/restart.txt', (err, stream) => {
    if (err) throw err;
    stream.on('close', () => {
      console.log('? Passenger restart.txt touched');
      conn.end();
    });
  });
}).on('error', console.error).connect({
  host: '82.180.143.125',
  port: 65002,
  username: 'u562700164',
  password: 'Guruhari@1723'
});
