import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import pool from '../config/db';
import { UnifiedAuthUser, LeaderScope } from '../@types/express';

interface DecodedToken {
  id: number;
  student_code?: string;
  username?: string;
  floor_id?: number;
  role?: string;
  roles?: string[];
  assigned_floors?: number[];
  assigned_wings?: string[];
  assigned_rooms?: string[];
  assigned_sessions?: string[];
}

/**
 * Universal authentication guard.
 * Supports Bearer tokens from students, student-leaders, and staff members.
 * Resolves active leadership and temporary role delegations.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<any> {
  let token: string | undefined;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    token = header.split(' ')[1];
  } else if (req.query.token) {
    token = req.query.token as string;
  }

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication token is required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret') as DecodedToken;

    // 1. Hardcoded Super Admin check
    if (decoded.role === 'admin' || decoded.id === 9999) {
      req.admin = decoded;
      req.user = {
        id: decoded.id,
        staff_id: decoded.id,
        username: 'admin',
        name: 'Super Admin',
        roles: ['platform-admin'],
        primary_role: 'platform-admin'
      };
      req.roles = ['platform-admin'];
      return next();
    }

    // 2. Hardcoded Operator check
    if (decoded.role === 'operator' || decoded.id === 99998) {
      req.operator = decoded;
      req.user = {
        id: decoded.id,
        username: 'operator',
        name: 'Manual Operator',
        roles: ['platform-admin'],
        primary_role: 'operator'
      };
      req.roles = ['operator'];
      return next();
    }

    // 3. Check if token belongs to a Student
    if (decoded.role === 'student' || decoded.student_code) {
      if (decoded.id === 99999) {
        // Test student
        req.student = {
          id: 99999,
          student_code: '0000',
          name: 'Test Student',
          floor_id: 9,
          role: 'student'
        };
        req.user = {
          id: 99999,
          student_id: 99999,
          name: 'Test Student',
          roles: ['student'],
          primary_role: 'student'
        };
        req.roles = ['student'];
        return next();
      }

      const [studentRows]: any = await pool.query(
        'SELECT id, student_code, name, phone_number, floor_id, room_number, is_active FROM students WHERE id = ?',
        [decoded.id]
      );

      if (studentRows.length === 0 || studentRows[0].is_active === 0) {
        return res.status(401).json({ success: false, message: 'Student account not found or inactive.' });
      }

      const student = studentRows[0];
      const userRoles: Array<'student' | 'leader' | 'wing-leader' | 'platform-admin' | 'complain-solver' | 'laundry-man' | 'delegated-role'> = ['student'];
      let scope: LeaderScope | undefined;

      // Check student leadership assignment
      const [leadRows]: any = await pool.query(
        'SELECT role, assigned_floors, assigned_wings, assigned_rooms FROM student_leadership WHERE student_id = ? AND is_active = TRUE',
        [student.id]
      );

      if (leadRows.length > 0) {
        const lead = leadRows[0];
        userRoles.push(lead.role);
        scope = {
          assigned_floors: typeof lead.assigned_floors === 'string' ? JSON.parse(lead.assigned_floors) : (lead.assigned_floors || []),
          assigned_wings: typeof lead.assigned_wings === 'string' ? JSON.parse(lead.assigned_wings) : (lead.assigned_wings || []),
          assigned_rooms: typeof lead.assigned_rooms === 'string' ? JSON.parse(lead.assigned_rooms) : (lead.assigned_rooms || [])
        };
      }

      // Check active role delegations
      const [delegations]: any = await pool.query(
        'SELECT delegated_role, entitlements FROM role_delegations WHERE student_id = ? AND is_active = TRUE AND valid_until > NOW()',
        [student.id]
      );

      for (const d of delegations) {
        if (!userRoles.includes(d.delegated_role)) {
          userRoles.push(d.delegated_role);
        }
        userRoles.push('delegated-role');
        if (d.entitlements) {
          const ent = typeof d.entitlements === 'string' ? JSON.parse(d.entitlements) : d.entitlements;
          if (!scope) scope = { assigned_floors: [] };
          if (ent.floors) scope.assigned_floors = Array.from(new Set([...scope.assigned_floors, ...ent.floors]));
          if (ent.wings) scope.assigned_wings = Array.from(new Set([...(scope.assigned_wings || []), ...ent.wings]));
        }
      }

      req.student = {
        id: student.id,
        student_code: student.student_code,
        name: student.name,
        floor_id: student.floor_id,
        room_number: student.room_number,
        role: 'student',
        roles: userRoles,
        scope
      };

      if (userRoles.includes('leader') || userRoles.includes('wing-leader')) {
        req.leader = {
          id: student.id,
          name: student.name,
          username: student.student_code,
          floor_id: student.floor_id,
          assigned_floors: scope?.assigned_floors || [student.floor_id],
          assigned_wings: scope?.assigned_wings || [],
          role: userRoles.includes('leader') ? 'floor_leader' : 'wing_leader'
        };
      }

      req.user = {
        id: student.id,
        student_id: student.id,
        name: student.name,
        roles: userRoles,
        primary_role: userRoles.includes('leader') ? 'leader' : userRoles.includes('wing-leader') ? 'wing-leader' : 'student',
        scope,
        delegations
      };
      req.roles = userRoles;

      return next();
    }

    // 4. Check if token belongs to Staff (platform-admin, complain-solver, laundry-man)
    const [staffRows]: any = await pool.query(
      'SELECT id, username, name, role, assigned_categories, is_active FROM staff_users WHERE id = ? AND is_active = TRUE',
      [decoded.id]
    );

    if (staffRows.length > 0) {
      const staff = staffRows[0];
      req.user = {
        id: staff.id,
        staff_id: staff.id,
        username: staff.username,
        name: staff.name,
        roles: [staff.role],
        primary_role: staff.role
      };
      req.roles = [staff.role];
      if (staff.role === 'platform-admin') req.admin = decoded;
      return next();
    }

    // 5. Fallback for Legacy Floor Leader
    const [legacyLeaders]: any = await pool.query(
      'SELECT * FROM floor_leaders WHERE id = ? AND is_active = TRUE',
      [decoded.id]
    );

    if (legacyLeaders.length > 0) {
      const leader = legacyLeaders[0];
      let assignedFloors = [leader.floor_id];
      try {
        if (leader.assigned_floors) {
          assignedFloors = typeof leader.assigned_floors === 'string' ? JSON.parse(leader.assigned_floors) : leader.assigned_floors;
        }
      } catch (e) {}

      req.leader = {
        id: leader.id,
        name: leader.name,
        username: leader.username,
        floor_id: leader.floor_id,
        assigned_floors: assignedFloors,
        role: 'floor_leader'
      };

      req.user = {
        id: leader.id,
        staff_id: leader.id,
        username: leader.username,
        name: leader.name,
        roles: ['leader'],
        primary_role: 'leader',
        scope: { assigned_floors: assignedFloors }
      };
      req.roles = ['leader'];
      return next();
    }

    return res.status(401).json({ success: false, message: 'Invalid or inactive user token' });
  } catch (err: any) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
    console.error('Auth middleware error:', err);
    return res.status(500).json({ success: false, message: 'Server error in auth middleware' });
  }
}

// Backward-compatible individual middlewares
export async function verifyStudent(req: Request, res: Response, next: NextFunction): Promise<any> {
  return requireAuth(req, res, () => {
    if (!req.student && !req.roles?.includes('student')) {
      return res.status(403).json({ success: false, message: 'Student access required' });
    }
    next();
  });
}

export async function verifyFloorLeader(req: Request, res: Response, next: NextFunction): Promise<any> {
  return requireAuth(req, res, () => {
    if (!req.roles?.includes('leader') && !req.roles?.includes('wing-leader') && !req.roles?.includes('platform-admin')) {
      return res.status(403).json({ success: false, message: 'Floor leader access required' });
    }
    next();
  });
}

export async function verifyAdmin(req: Request, res: Response, next: NextFunction): Promise<any> {
  return requireAuth(req, res, () => {
    if (!req.roles?.includes('platform-admin')) {
      return res.status(403).json({ success: false, message: 'Platform admin access required' });
    }
    next();
  });
}

export async function verifyAdminOrFloorLeader(req: Request, res: Response, next: NextFunction): Promise<any> {
  return requireAuth(req, res, () => {
    const isAllowed = req.roles?.some(r => ['platform-admin', 'leader', 'wing-leader', 'operator'].includes(r));
    if (!isAllowed) {
      return res.status(403).json({ success: false, message: 'Admin or Floor Leader access required' });
    }
    next();
  });
}

export async function verifyOperator(req: Request, res: Response, next: NextFunction): Promise<any> {
  return requireAuth(req, res, () => {
    if (!req.roles?.includes('operator') && !req.roles?.includes('platform-admin')) {
      return res.status(403).json({ success: false, message: 'Operator access required' });
    }
    next();
  });
}
