import mysql, { Pool } from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

export const pool: Pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'hostel_attendent',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true
});

export async function runMigrations(): Promise<void> {
  try {
    // 1. Students Columns
    const [columns]: any = await pool.query(`SHOW COLUMNS FROM students LIKE 'room_number'`);
    if (columns.length === 0) {
      await pool.query(`ALTER TABLE students ADD COLUMN room_number VARCHAR(20) DEFAULT NULL`);
    }

    try { await pool.query('ALTER TABLE students ADD COLUMN is_default_present BOOLEAN DEFAULT FALSE'); } catch (e) {}
    try { await pool.query('ALTER TABLE students ADD COLUMN father_phone VARCHAR(20) DEFAULT NULL'); } catch (e) {}
    try { await pool.query('ALTER TABLE students ADD COLUMN mother_phone VARCHAR(20) DEFAULT NULL'); } catch (e) {}
    try { await pool.query('ALTER TABLE students ADD COLUMN parent_phone VARCHAR(20) DEFAULT NULL'); } catch (e) {}

    // 2. Attendance Schedules & Records
    try { await pool.query('ALTER TABLE attendance_schedules ADD COLUMN linked_session_key VARCHAR(50) DEFAULT NULL'); } catch (e) {}
    try { await pool.query('ALTER TABLE attendance_schedules ADD COLUMN late_time TIME DEFAULT NULL'); } catch (e) {}
    try { await pool.query('ALTER TABLE attendance_schedules ADD COLUMN auto_message TEXT DEFAULT NULL'); } catch (e) {}
    try { await pool.query('ALTER TABLE attendance_schedules ADD COLUMN auto_message_parent TEXT DEFAULT NULL'); } catch (e) {}
    try { await pool.query('ALTER TABLE attendance_schedules ADD COLUMN auto_message_student TEXT DEFAULT NULL'); } catch (e) {}
    try { await pool.query('ALTER TABLE attendance_schedules ADD COLUMN auto_message_time TIME DEFAULT NULL'); } catch (e) {}
    try { await pool.query('ALTER TABLE attendance_schedules ADD COLUMN auto_message_audience VARCHAR(50) DEFAULT "absent"'); } catch (e) {}
    try { await pool.query('ALTER TABLE attendance_schedules ADD COLUMN last_auto_message_date DATE NULL'); } catch (e) {}
    try { await pool.query('ALTER TABLE attendance_schedules ADD COLUMN is_for_all_students BOOLEAN DEFAULT TRUE'); } catch (e) {}
    try { await pool.query('ALTER TABLE attendance_records ADD COLUMN is_late BOOLEAN DEFAULT FALSE'); } catch (e) {}
    try { await pool.query('ALTER TABLE attendance_records ADD COLUMN bank_code VARCHAR(50) NOT NULL'); } catch (e) {}
    try { await pool.query('ALTER TABLE attendance_records ADD COLUMN student_name VARCHAR(100) NULL'); } catch (e) {}
    try { await pool.query('ALTER TABLE attendance_records ADD COLUMN remarks TEXT NULL'); } catch (e) {}

    // 3. Floors
    try { await pool.query('ALTER TABLE floors ADD COLUMN device_name VARCHAR(100) DEFAULT NULL'); } catch (e) {}
    try { await pool.query('ALTER TABLE floors ADD COLUMN last_seen DATETIME DEFAULT NULL'); } catch (e) {}
    try { await pool.query('ALTER TABLE floors ADD COLUMN current_token VARCHAR(100) DEFAULT NULL'); } catch (e) {}

    // 4. Floor Leaders Legacy Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS floor_leaders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(100) UNIQUE NULL,
        name VARCHAR(100) NOT NULL,
        phone_number VARCHAR(50) DEFAULT NULL,
        password_hash VARCHAR(255) NOT NULL,
        assigned_floors JSON DEFAULT NULL,
        assigned_sessions JSON DEFAULT NULL,
        floor_id INT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // 5. Floor Session Targets
    await pool.query(`
      CREATE TABLE IF NOT EXISTS floor_session_targets (
        floor_id INT NOT NULL,
        session_key VARCHAR(50) NOT NULL,
        target_type VARCHAR(20) NOT NULL DEFAULT 'ALL',
        student_ids JSON,
        PRIMARY KEY (floor_id, session_key)
      )
    `);

    // 6. Student Tags & AI Logs
    await pool.query(`
      CREATE TABLE IF NOT EXISTS student_tags (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(50) UNIQUE NOT NULL,
        color VARCHAR(20) DEFAULT '#6366f1',
        is_system BOOLEAN DEFAULT FALSE,
        description VARCHAR(255) DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS student_tag_assignments (
        student_id INT NOT NULL,
        tag_id INT NOT NULL,
        assigned_by VARCHAR(50) DEFAULT 'ADMIN',
        assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (student_id, tag_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_tag_analysis_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        assigned_tag VARCHAR(50) NOT NULL,
        reason TEXT,
        analyzed_days INT DEFAULT 20,
        analyzed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX (student_id),
        INDEX (analyzed_at)
      )
    `);

    // ==========================================
    // NEW RBAC & DELEGATION TABLES
    // ==========================================
    // 7. Staff Users Table (platform-admin, complain-solver, laundry-man)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS staff_users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        phone_number VARCHAR(50) DEFAULT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role ENUM('platform-admin', 'complain-solver', 'laundry-man') NOT NULL,
        assigned_categories JSON DEFAULT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (role),
        INDEX (is_active)
      )
    `);

    // 8. Student Leadership Table (leader & wing-leader assigned to students)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS student_leadership (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        role ENUM('leader', 'wing-leader') NOT NULL,
        assigned_floors JSON NOT NULL,
        assigned_wings JSON DEFAULT NULL,
        assigned_rooms JSON DEFAULT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        UNIQUE KEY unique_student_leadership (student_id)
      )
    `);

    // 9. Role Delegations Table (Temporary permissions granted to students/staff)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS role_delegations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        delegator_id INT NOT NULL,
        student_id INT NOT NULL,
        delegated_role ENUM('leader', 'wing-leader', 'complain-solver', 'laundry-man') NOT NULL,
        entitlements JSON DEFAULT NULL,
        valid_from DATETIME DEFAULT CURRENT_TIMESTAMP,
        valid_until DATETIME NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        INDEX (student_id, is_active),
        INDEX (valid_until)
      )
    `);

    // ==========================================
    // ENHANCED COMPLAINTS SCHEMA (USING student_id)
    // ==========================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS complains (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        room VARCHAR(20) DEFAULT NULL,
        compType VARCHAR(50) NOT NULL,
        compDesc TEXT NOT NULL,
        images INT DEFAULT 0,
        status ENUM('pending', 'in_progress', 'solved', 'resolved', 'auto_closed') DEFAULT 'pending',
        assigned_solver_id INT DEFAULT NULL,
        solver_response TEXT DEFAULT NULL,
        student_feedback TEXT DEFAULT NULL,
        student_rating TINYINT DEFAULT NULL,
        submitTime DATETIME DEFAULT CURRENT_TIMESTAMP,
        solvedTime DATETIME DEFAULT NULL,
        resolveTime DATETIME DEFAULT NULL,
        INDEX (student_id),
        INDEX (status),
        INDEX (compType),
        INDEX (solvedTime)
      )
    `);

    // Make sure student_id column exists if table was created previously with bank_code
    try {
      const [compCols]: any = await pool.query(`SHOW COLUMNS FROM complains LIKE 'student_id'`);
      if (compCols.length === 0) {
        await pool.query(`ALTER TABLE complains ADD COLUMN student_id INT NOT NULL DEFAULT 0 AFTER id`);
        await pool.query(`UPDATE complains c JOIN students s ON c.bank_code = s.student_code SET c.student_id = s.id`);
      }
      const [solvedTimeCols]: any = await pool.query(`SHOW COLUMNS FROM complains LIKE 'solvedTime'`);
      if (solvedTimeCols.length === 0) {
        await pool.query(`ALTER TABLE complains ADD COLUMN solvedTime DATETIME DEFAULT NULL AFTER submitTime`);
      }
      const [solverRespCols]: any = await pool.query(`SHOW COLUMNS FROM complains LIKE 'solver_response'`);
      if (solverRespCols.length === 0) {
        await pool.query(`ALTER TABLE complains ADD COLUMN solver_response TEXT DEFAULT NULL`);
      }
      const [studFbCols]: any = await pool.query(`SHOW COLUMNS FROM complains LIKE 'student_feedback'`);
      if (studFbCols.length === 0) {
        await pool.query(`ALTER TABLE complains ADD COLUMN student_feedback TEXT DEFAULT NULL`);
      }
      const [studRatingCols]: any = await pool.query(`SHOW COLUMNS FROM complains LIKE 'student_rating'`);
      if (studRatingCols.length === 0) {
        await pool.query(`ALTER TABLE complains ADD COLUMN student_rating TINYINT DEFAULT NULL`);
      }
      const [assignedSolverCols]: any = await pool.query(`SHOW COLUMNS FROM complains LIKE 'assigned_solver_id'`);
      if (assignedSolverCols.length === 0) {
        await pool.query(`ALTER TABLE complains ADD COLUMN assigned_solver_id INT DEFAULT NULL`);
      }
    } catch (e) {}

    // Complains Archive Table (stores confirmed resolved and auto-closed tickets)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS complains_archive (
        id INT PRIMARY KEY,
        student_id INT NOT NULL,
        room VARCHAR(20) DEFAULT NULL,
        compType VARCHAR(50) NOT NULL,
        compDesc TEXT NOT NULL,
        images INT DEFAULT 0,
        status VARCHAR(20) NOT NULL,
        assigned_solver_id INT DEFAULT NULL,
        solver_response TEXT DEFAULT NULL,
        student_feedback TEXT DEFAULT NULL,
        student_rating TINYINT DEFAULT NULL,
        submitTime DATETIME NOT NULL,
        solvedTime DATETIME DEFAULT NULL,
        archivedTime DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX (student_id),
        INDEX (compType)
      )
    `);

    // Student Category Locks Table (locks category if 24 hours pass without student feedback)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS student_category_locks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        category VARCHAR(50) NOT NULL,
        locked_reason VARCHAR(255) DEFAULT 'Failed to provide resolution feedback within 24 hours',
        locked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_locked BOOLEAN DEFAULT TRUE,
        unlocked_by INT DEFAULT NULL,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        UNIQUE KEY unique_student_cat_lock (student_id, category)
      )
    `);

    // ==========================================
    // ENHANCED LAUNDRY SCHEMA (USING student_id)
    // ==========================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS laundry (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        pants INT DEFAULT 0,
        pressPants INT DEFAULT 0,
        shirts INT DEFAULT 0,
        pressShirts INT DEFAULT 0,
        tShirts INT DEFAULT 0,
        pressTShirts INT DEFAULT 0,
        towels INT DEFAULT 0,
        pressTowels INT DEFAULT 0,
        others INT DEFAULT 0,
        pressOthers INT DEFAULT 0,
        blanket INT DEFAULT 0,
        jacket INT DEFAULT 0,
        bedSheet INT DEFAULT 0,
        washPrice INT DEFAULT 4,
        pressPrice INT DEFAULT 4,
        blanketPrice INT DEFAULT 20,
        jacketPrice INT DEFAULT 20,
        bedSheetPrice INT DEFAULT 8,
        status ENUM('pending', 'accepted', 'washed', 'received') DEFAULT 'pending',
        processed_by INT DEFAULT NULL,
        submitTime DATETIME DEFAULT CURRENT_TIMESTAMP,
        acceptTime DATETIME DEFAULT NULL,
        washTime DATETIME DEFAULT NULL,
        receiveTime DATETIME DEFAULT NULL,
        INDEX (student_id),
        INDEX (status)
      )
    `);

    try {
      const [laundryCols]: any = await pool.query(`SHOW COLUMNS FROM laundry LIKE 'student_id'`);
      if (laundryCols.length === 0) {
        await pool.query(`ALTER TABLE laundry ADD COLUMN student_id INT NOT NULL DEFAULT 0 AFTER id`);
        await pool.query(`UPDATE laundry l JOIN students s ON l.bank_code = s.student_code SET l.student_id = s.id`);
      }
      const [procByCols]: any = await pool.query(`SHOW COLUMNS FROM laundry LIKE 'processed_by'`);
      if (procByCols.length === 0) {
        await pool.query(`ALTER TABLE laundry ADD COLUMN processed_by INT DEFAULT NULL`);
      }
    } catch (e) {}

    // Laundry Recharge Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS laundryrecharge (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT NOT NULL,
        amount DECIMAL(10, 2) NOT NULL,
        recorded_by INT DEFAULT NULL,
        time DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX (student_id)
      )
    `);

    try {
      const [rechCols]: any = await pool.query(`SHOW COLUMNS FROM laundryrecharge LIKE 'student_id'`);
      if (rechCols.length === 0) {
        await pool.query(`ALTER TABLE laundryrecharge ADD COLUMN student_id INT NOT NULL DEFAULT 0 AFTER id`);
        await pool.query(`UPDATE laundryrecharge lr JOIN students s ON lr.bank_code = s.student_code SET lr.student_id = s.id`);
      }
    } catch (e) {}

    console.log('Database schema auto-migrations executed successfully.');
  } catch (err: any) {
    console.error(`Error during database migrations: ${err.message}`);
  }
}

export default pool;
