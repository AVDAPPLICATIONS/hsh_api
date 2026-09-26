import { Request } from 'express';

export interface StudentAuthPayload {
  id: number;
  student_code: string;
  name?: string;
  floor_id: number;
  room_number?: string;
  role: 'student';
}

export interface StaffAuthPayload {
  id: number;
  username: string;
  name?: string;
  role: 'platform-admin' | 'complain-solver' | 'laundry-man';
  assigned_categories?: string[];
}

export interface LeaderScope {
  assigned_floors: number[];
  assigned_wings?: string[];
  assigned_rooms?: string[];
  assigned_sessions?: string[];
}

export interface UnifiedAuthUser {
  id: number; // student_id or staff_id
  student_id?: number;
  staff_id?: number;
  username?: string;
  name?: string;
  phone_number?: string;
  roles: Array<'student' | 'leader' | 'wing-leader' | 'platform-admin' | 'complain-solver' | 'laundry-man' | 'delegated-role'>;
  primary_role: string;
  scope?: LeaderScope;
  delegations?: any[];
}

declare global {
  namespace Express {
    interface Request {
      user?: UnifiedAuthUser;
      student?: StudentAuthPayload & { roles?: string[]; scope?: LeaderScope };
      leader?: any;
      admin?: any;
      operator?: any;
      roles?: string[];
    }
  }
}
