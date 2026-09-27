process.env.TZ = 'Asia/Kolkata';
import dotenv from 'dotenv';
dotenv.config();

import express, { } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';

// Database & Auto-migrations
import pool, { runMigrations } from './config/db';

// Background Services
import './services/cron';
import whatsappService from './services/whatsapp';

// Routes
import authRoutes from './modules/auth/auth.routes';
import complainRoutes from './modules/complain/complain.routes';
import laundryRoutes from './modules/laundry/laundry.routes';
import feesRoutes from './modules/fees/fees.routes';
import delegationRoutes from './modules/delegation/delegation.routes';
import attendanceRoutes from './modules/attendance/attendance.routes';
import adminRoutes from './modules/admin/admin.routes';
import studentsRoutes from './modules/students/students.routes';
import floorsRoutes from './modules/floors/floors.routes';
import esp32Routes from './modules/esp32/esp32.routes';
import versionRoutes from './modules/version/version.routes';
import whatsappRoutes from './modules/whatsapp/whatsapp.routes';
import notificationRoutes from './modules/notification/notification.routes';
import tagsRoutes from './modules/tags/tags.routes';
import leadersRoutes from './modules/leaders/leaders.routes';
import rebindRoutes from './modules/rebind/rebind.routes';
import screentimeRoutes from './modules/screentime/screentime.routes';

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-hsh-auth-token']
}));

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Static asset folders
const apksDir = path.resolve('public/apks');
if (!fs.existsSync(apksDir)) {
  fs.mkdirSync(apksDir, { recursive: true });
}
app.use('/apks', express.static(apksDir));

const uploadsDir = path.resolve('public/uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

// Health check endpoint
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'hostel-attendance-backend',
    version: '2.0.0-typescript',
    timestamp: new Date().toISOString()
  });
});

// Run startup database migrations
runMigrations().catch(err => console.error('Migration initialization error:', err));

// Route bindings (Mounted with both /api/<path> and /<path> for client compatibility)
const mountRoute = (prefix, handler) => {
  app.use(`/api/${prefix}`, handler);
  app.use(`/${prefix}`, handler);
};

mountRoute('auth', authRoutes);
mountRoute('complain', complainRoutes);
mountRoute('complains', complainRoutes);
mountRoute('laundry', laundryRoutes);
mountRoute('fees', feesRoutes);
mountRoute('delegation', delegationRoutes);
mountRoute('attendance', attendanceRoutes);
mountRoute('admin', adminRoutes);
mountRoute('students', studentsRoutes);
mountRoute('floors', floorsRoutes);
mountRoute('esp32', esp32Routes);
mountRoute('version', versionRoutes);
mountRoute('whatsapp', whatsappRoutes);
mountRoute('notification', notificationRoutes);
mountRoute('tags', tagsRoutes);
mountRoute('leaders', leadersRoutes);
mountRoute('rebind', rebindRoutes);
mountRoute('screen-time', screentimeRoutes);

// Legacy utility endpoints for backwards compatibility
app.get(['/api/migrate-room', '/migrate-room'], async (_req, res) => {
  res.send('Schema migrations now run automatically on backend startup.');
});

app.get(['/api/force-cleanup', '/force-cleanup'], async (_req, res) => {
  const https = require('https');
  try {
    const apiData = await new Promise((resolve, reject) => {
      https.get('https://api.avdvvn.org/public/getStudentBasicDetails', {
        headers: { 'x-hsh-auth-token': 'aF92Kx7QmN4Lp8Vz' }
      }, (response) => {
        let data = '';
        response.on('data', (chunk) => data += chunk);
        response.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });

    if (!apiData || !apiData.data) {
      return res.status(500).send('No data from API');
    }

    let logs = [];
    let deletedCount = 0;
    logs.push(`Total students from external API: ${apiData.data.length}`);

    for (const extStudent of apiData.data) {
      if (!extStudent.bankCode) continue;
      const canonicalUsername = extStudent.bankCode;
      const roomRaw = extStudent.room ? extStudent.room.toString().trim() : '';

      if (!roomRaw || roomRaw === 'null' || roomRaw === '') {
        const [existing] = await pool.query('SELECT id, name FROM students WHERE student_code = ?', [canonicalUsername]);
        if (existing.length > 0) {
          const sid = existing[0].id;
          logs.push(`Deleting ${existing[0].name} (Bank: ${canonicalUsername}, No Room)`);
          try {
            await pool.query('DELETE FROM rebind_requests WHERE student_id = ?', [sid]);
            await pool.query("DELETE FROM attendance_records WHERE TRIM(LEADING '0' FROM bank_code) = TRIM(LEADING '0' FROM ?)", [canonicalUsername]);
            await pool.query('DELETE FROM students WHERE id = ?', [sid]);
            deletedCount++;
          } catch (err) {
            logs.push(`ERROR DELETING ${canonicalUsername}: ${err.message}`);
          }
        }
      }
    }

    logs.push(`Cleanup complete! Successfully deleted ${deletedCount} unassigned students.`);
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM students');
    logs.push(`Total students remaining in database: ${total}`);
    res.type('text/plain').send(logs.join('\n'));
  } catch (e) {
    res.status(500).type('text/plain').send(`Fatal Error during cleanup:\n${e.stack}`);
  }
});

// Fallback error handler
app.use((err, _req, res, _next) => {
  console.error('[Error Handler]', err);
  res.status(500).json({
    success: false,
    message: err.message || 'Unexpected server error'
  });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  console.log(`🚀 Hostel Attendance & Management Backend running on http://localhost:${PORT}`);
  whatsappService.connectWhatsApp().catch(err => console.error('Auto-connect WhatsApp failed:', err));
});

export default app;
