const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const SftpClient = require('ssh2-sftp-client');

const SSH_CONFIG = {
  host: '82.180.143.125',
  port: 65002,
  username: 'u562700164',
  password: 'Guruhari@1723'
};

const REMOTE_BACKEND =
  '/home/u562700164/domains/attendentsnews.hpys.in/hbuilds/current/nodejs';

const ROOT_DIR = path.resolve(__dirname);

async function runSshCommand(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);

      let stdout = '';
      let stderr = '';

      stream
        .on('close', (code) => {
          if (code === 0) {
            resolve(stdout);
          } else {
            reject(
              new Error(`Exit code ${code}: ${stderr || stdout}`)
            );
          }
        })
        .on('data', (data) => {
          stdout += data.toString();
          process.stdout.write(data.toString());
        })
        .stderr.on('data', (data) => {
          stderr += data.toString();
          process.stderr.write(data.toString());
        });
    });
  });
}

async function uploadDirectory(sftp, localDir, remoteDir, label) {
  if (!fs.existsSync(localDir)) {
    console.log(`⚠️ Skipping ${label}: ${localDir} does not exist.`);
    return;
  }

  console.log(`\n📤 Uploading ${label}...`);
  console.log(`   Local : ${localDir}`);
  console.log(`   Remote: ${remoteDir}`);

  await sftp.mkdir(remoteDir, true);
  await sftp.uploadDir(localDir, remoteDir);

  console.log(`✅ ${label} uploaded successfully.`);
}

async function uploadFile(sftp, localFile, remoteFile) {
  if (!fs.existsSync(localFile)) {
    console.log(`⚠️ Skipping: ${path.basename(localFile)} does not exist.`);
    return;
  }

  await sftp.put(localFile, remoteFile);
  console.log(`   📄 Uploaded ${path.basename(localFile)}`);
}

async function restartBackend() {
  console.log('\n🔄 Restarting Node.js backend...');

  const conn = new Client();

  await new Promise((resolve, reject) => {
    conn
      .on('ready', async () => {
        try {
          const restartCmd = `
            mkdir -p "${REMOTE_BACKEND}/tmp" &&
            touch "${REMOTE_BACKEND}/tmp/restart.txt"
          `;

          await runSshCommand(conn, restartCmd);

          console.log('✅ Passenger restart signal sent.');
          conn.end();
          resolve();
        } catch (err) {
          conn.end();
          reject(err);
        }
      })
      .on('error', reject)
      .connect(SSH_CONFIG);
  });
}

async function main() {
  console.log('====================================================');
  console.log('🚀 HAMS BACKEND ONLY DEPLOYMENT');
  console.log('====================================================');
  console.log('🌐 Website: https://attendentsnews.hpys.in/');
  console.log(`📁 Remote: ${REMOTE_BACKEND}`);
  console.log('====================================================\n');

  // --------------------------------------------------
  // STEP 1: Connect SFTP
  // --------------------------------------------------

  console.log('🔐 Connecting to server...');
  const sftp = new SftpClient();

  await sftp.connect(SSH_CONFIG);

  console.log('✅ SFTP Connected.');

  // --------------------------------------------------
  // STEP 2: Backend folders (dist, src, config, public, etc.)
  // --------------------------------------------------

  const backendFolders = [
    'dist',
    'src',
    'config',
    'middleware',
    'routes',
    'services',
    'utils',
    'public',
    'database_export'
  ];

  console.log('\n📦 Uploading backend folders...');

  for (const folder of backendFolders) {
    const localFolder = path.join(ROOT_DIR, folder);

    if (!fs.existsSync(localFolder)) {
      continue;
    }

    const remoteFolder = `${REMOTE_BACKEND}/${folder}`;

    await uploadDirectory(
      sftp,
      localFolder,
      remoteFolder,
      `${folder}/`
    );
  }

  // --------------------------------------------------
  // STEP 3: Backend files
  // --------------------------------------------------

  const backendFiles = [
    'server.js',
    'package.json',
    'package-lock.json',
    'ecosystem.config.js',
    'api_data.json'
  ];

  console.log('\n📄 Uploading backend files...');

  for (const file of backendFiles) {
    const localFile = path.join(ROOT_DIR, file);
    const remoteFile = `${REMOTE_BACKEND}/${file}`;

    await uploadFile(
      sftp,
      localFile,
      remoteFile
    );
  }

  // --------------------------------------------------
  // STEP 4: Close SFTP
  // --------------------------------------------------

  await sftp.end();

  console.log('\n✅ All backend files uploaded.');

  // --------------------------------------------------
  // STEP 5: Restart Node.js / Passenger
  // --------------------------------------------------

  await restartBackend();

  // --------------------------------------------------
  // STEP 6: Done
  // --------------------------------------------------

  console.log('\n====================================================');
  console.log('🎉 BACKEND DEPLOYMENT COMPLETE!');
  console.log('====================================================');
  console.log('🌐 Backend: https://attendentsnews.hpys.in/');
  console.log('====================================================\n');
}

main().catch((err) => {
  console.error('\n❌ DEPLOYMENT FAILED!');
  console.error(err);
  process.exit(1);
});
