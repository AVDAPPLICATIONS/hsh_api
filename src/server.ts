process.env.TZ = 'Asia/Kolkata';
import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';

// Database & Auto-migrations
import { runMigrations } from './config/db';

// Background Services
import './services/cron';
import whatsappService from './services/whatsapp';

// Routes
import authRoutes from './modules/auth/auth.routes';
import complainRoutes from './modules/complain/complain.routes';
import laundryRoutes from './modules/laundry/laundry.routes';
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
app.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'hostel-attendance-backend',
    version: '2.0.0-typescript',
    timestamp: new Date().toISOString()
  });
});

// Run startup database migrations
runMigrations().catch(err => console.error('Migration initialization error:', err));

// Route bindings
app.use('/api/auth', authRoutes);
app.use('/api/complain', complainRoutes);
app.use('/api/laundry', laundryRoutes);
app.use('/api/delegation', delegationRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/students', studentsRoutes);
app.use('/api/floors', floorsRoutes);
app.use('/api/esp32', esp32Routes);
app.use('/api/version', versionRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/notification', notificationRoutes);
app.use('/api/tags', tagsRoutes);
app.use('/api/leaders', leadersRoutes);
app.use('/api/rebind', rebindRoutes);

// Fallback error handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
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
