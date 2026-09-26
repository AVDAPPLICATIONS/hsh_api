# Repository Engineering Rules & Architecture Guide

## 1. Core Principles
- **Language**: TypeScript (`ES2022`, target `CommonJS` or `ESNext`).
- **Framework**: Express.js with modular routing architecture located under `src/modules/<feature>/<feature>.routes.ts`.
- **Database**: MySQL via `mysql2/promise` connection pool (`src/config/db.ts`).
- **Process Manager**: PM2 running in `fork` mode (`ecosystem.config.js`).

## 2. Authentication & Roles
- **Dual Identity for Students**:
  - `leader` and `wing-leader` are active students.
  - Resolved dynamically in `src/middleware/auth.ts` from `student_leadership` and `role_delegations`.
  - Roles attached to `req.user.roles`.
- **Staff Users**:
  - `platform-admin`, `complain-solver`, `laundry-man` authenticate from `staff_users`.
- **Delegated Role (`delegated-role`)**:
  - Granted with explicit expiry dates and checked per request.

## 3. Complaint & 24h SLA Lockout Rule
- Student files complaint $\rightarrow$ Solver marks `status = 'solved'` and `solvedTime = NOW()`.
- Student has 24 hours to confirm or dispute.
- If 24 hours elapse without confirmation:
  - System background sweeper (`src/services/cron.ts`) locks the category in `student_category_locks`.
  - Ticket is archived to `complains_archive` with `status = 'auto_closed'`.
  - Ticket is purged from active `complains`.
  - New complaints for that student and category are rejected until an admin/leader unlocks it.

## 4. Laundry Lifecycle
- Stages: `pending` $\rightarrow$ `accepted` $\rightarrow$ `washed` $\rightarrow$ `received`.
- Primary identifier is `student_id`.

## 5. Coding Standards
- Parameterized SQL queries only.
- Standard response envelope: `{ status: 'success' | 'error', data?: any, message?: string }`.
- Time must use IST helper (`src/utils/time.ts`).
