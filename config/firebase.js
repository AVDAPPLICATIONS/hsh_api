const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else {
    const filePath = path.join(__dirname, "../firebase-service-account.json");
    if (fs.existsSync(filePath)) {
      serviceAccount = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } else {
      throw new Error("No Firebase configuration found.");
    }
  }
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("Firebase initialized successfully.");
} catch (error) {
  console.warn("WARNING: Firebase credentials missing or invalid! Push notifications will be disabled.");
  
  // Create a dummy admin object so the rest of the code doesn't crash when calling admin.messaging()
  admin.messaging = () => ({
    sendMulticast: async () => ({ successCount: 0, failureCount: 0 }),
    send: async () => ({})
  });
}

module.exports = admin;
