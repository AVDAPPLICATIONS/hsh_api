const path = require('path');
const fs = require('fs');
const SftpClient = require('ssh2-sftp-client');
const { Client } = require('ssh2');

const SSH_CONFIG = {
  host: '82.180.143.125',
  port: 65002,
  username: 'u562700164',
  password: 'Guruhari@1723'
};

const REMOTE_BACKEND = '/home/u562700164/domains/attendentsnews.hpys.in/hbuilds/current/nodejs';

async function main() {
  const sftp = new SftpClient();
  await sftp.connect(SSH_CONFIG);
  console.log('Connected to SFTP');

  const pkgs = ['axios', 'follow-redirects', 'form-data', 'proxy-from-env', 'asynckit', 'combined-stream', 'delayed-stream'];

  for (const pkg of pkgs) {
    const localDir = path.resolve(__dirname, 'node_modules', pkg);
    if (!fs.existsSync(localDir)) continue;
    const remoteDir = REMOTE_BACKEND + '/node_modules/' + pkg;
    console.log('Uploading ' + pkg + '...');
    await sftp.mkdir(remoteDir, true);
    await sftp.uploadDir(localDir, remoteDir);
    console.log('Uploaded ' + pkg);
  }

  await sftp.end();
  console.log('Done uploading missing modules!');

  // Restart passenger
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', () => {
      conn.exec('mkdir -p "' + REMOTE_BACKEND + '/tmp" && touch "' + REMOTE_BACKEND + '/tmp/restart.txt"', (err, stream) => {
        if (err) return reject(err);
        stream.on('close', () => {
          console.log('Passenger restarted');
          conn.end();
          resolve();
        });
      });
    }).on('error', reject).connect(SSH_CONFIG);
  });
}

main().catch(console.error);
