const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const VERSION_FILE_PATH = path.join(__dirname, '..', 'config', 'version.json');

// Default template if file doesn't exist
const DEFAULT_VERSION_DATA = {
  latest_version_code: 1,
  latest_version_name: "1.0.0",
  apk_url: "https://example.com/app.apk",
  update_message: "New version available!",
  force_update: false
};

const multer = require('multer');

// Configure multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const apksDir = path.join(__dirname, '..', 'public', 'apks');
    if (!fs.existsSync(apksDir)) {
      fs.mkdirSync(apksDir, { recursive: true });
    }
    cb(null, apksDir);
  },
  filename: function (req, file, cb) {
    // Save with a timestamp to prevent overwriting, or just use original name
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext);
    cb(null, `${basename}-${Date.now()}${ext}`);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.apk')) {
      cb(null, true);
    } else {
      cb(new Error('Only .apk files are allowed!'), false);
    }
  }
});

// ------------------------------------------------------------
// POST /api/version/upload
// ------------------------------------------------------------
router.post('/upload', upload.single('apkFile'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    // Return the relative URL
    const apkUrl = `/apks/${req.file.filename}`;
    return res.json({ success: true, url: apkUrl, message: 'APK uploaded successfully' });
  } catch (err) {
    console.error('Error uploading APK:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// GET /api/version
// ------------------------------------------------------------
router.get('/', (req, res) => {
  try {
    if (!fs.existsSync(VERSION_FILE_PATH)) {
      return res.json({ success: true, data: DEFAULT_VERSION_DATA });
    }
    const data = fs.readFileSync(VERSION_FILE_PATH, 'utf8');
    return res.json({ success: true, data: JSON.parse(data) });
  } catch (err) {
    console.error('Error reading version file:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ------------------------------------------------------------
// POST /api/version
// ------------------------------------------------------------
router.post('/', (req, res) => {
  try {
    const { latest_version_code, latest_version_name, apk_url, update_message, force_update } = req.body;
    
    const newVersionData = {
      latest_version_code: parseInt(latest_version_code, 10) || 1,
      latest_version_name: latest_version_name || "1.0.0",
      apk_url: apk_url || "",
      update_message: update_message || "New update available",
      force_update: force_update === true
    };

    const configDir = path.dirname(VERSION_FILE_PATH);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    fs.writeFileSync(VERSION_FILE_PATH, JSON.stringify(newVersionData, null, 2), 'utf8');

    return res.json({ success: true, message: 'Version information updated', data: newVersionData });
  } catch (err) {
    console.error('Error writing version file:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
