import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';

const router = Router();
const VERSION_FILE_PATH = path.resolve('src/config/version.json');

const DEFAULT_VERSION_DATA = {
  latest_version_code: 1,
  latest_version_name: '1.0.0',
  apk_url: 'https://example.com/app.apk',
  update_message: 'New version available!',
  force_update: false
};

const apksDir = path.resolve('public/apks');
if (!fs.existsSync(apksDir)) {
  fs.mkdirSync(apksDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, apksDir);
  },
  filename: function (_req, file, cb) {
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext);
    cb(null, `${basename}-${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (file.originalname.endsWith('.apk')) {
      cb(null, true);
    } else {
      cb(new Error('Only .apk files are allowed!'));
    }
  }
});

// POST /api/version/upload
router.post('/upload', upload.single('apkFile'), (req: Request, res: Response): any => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    const apkUrl = `/apks/${req.file.filename}`;
    return res.json({ success: true, url: apkUrl, message: 'APK uploaded successfully' });
  } catch (err: any) {
    console.error('Error uploading APK:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/version
router.get('/', (_req: Request, res: Response): any => {
  try {
    if (!fs.existsSync(VERSION_FILE_PATH)) {
      return res.json({ success: true, data: DEFAULT_VERSION_DATA });
    }
    const data = fs.readFileSync(VERSION_FILE_PATH, 'utf8');
    return res.json({ success: true, data: JSON.parse(data) });
  } catch (err: any) {
    console.error('Error reading version file:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/version
router.post('/', (req: Request, res: Response): any => {
  try {
    const { latest_version_code, latest_version_name, apk_url, update_message, force_update } = req.body;

    const newVersionData = {
      latest_version_code: parseInt(latest_version_code, 10) || 1,
      latest_version_name: latest_version_name || '1.0.0',
      apk_url: apk_url || '',
      update_message: update_message || 'New update available',
      force_update: force_update === true
    };

    const configDir = path.dirname(VERSION_FILE_PATH);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    fs.writeFileSync(VERSION_FILE_PATH, JSON.stringify(newVersionData, null, 2), 'utf8');
    return res.json({ success: true, message: 'Version information updated', data: newVersionData });
  } catch (err: any) {
    console.error('Error writing version file:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
