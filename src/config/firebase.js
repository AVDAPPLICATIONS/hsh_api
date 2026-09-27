import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

let isInitialized = false;

try {
  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else {
    const filePath = path.resolve('firebase-service-account.json');
    if (fs.existsSync(filePath)) {
      serviceAccount = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  }

  if (serviceAccount) {
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    isInitialized = true;
    console.log('Firebase initialized successfully.');
  } else {
    console.warn('WARNING: Firebase credentials missing! Push notifications will be disabled.');
  }
} catch (error) {
  console.warn('WARNING: Firebase credentials invalid! Push notifications will be disabled:', error.message);
}

const firebaseWrapper = {
  messaging: () => {
    if (isInitialized) {
      try {
        return admin.messaging();
      } catch (e) {}
    }
    return {
      sendMulticast: async () => ({ successCount: 0, failureCount: 0 }),
      send: async () => ({})
    };
  }
};

export default firebaseWrapper;
