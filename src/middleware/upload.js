import multer from 'multer';
import path from 'path';
import fs from 'fs';

export const COMPLAIN_UPLOAD_DIR = path.resolve('public/uploads/complains');
if (!fs.existsSync(COMPLAIN_UPLOAD_DIR)) {
  fs.mkdirSync(COMPLAIN_UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, COMPLAIN_UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `temp_${Date.now()}_${Math.random().toString(36).substring(7)}${ext}`);
  }
});

export const uploadComplainImages = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit per image
});
