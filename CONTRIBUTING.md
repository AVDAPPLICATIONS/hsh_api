# Engineering Contribution & Workflow Guidelines

Welcome to the **Hostel Attendance & Management System (HAMS)** backend. All developers must follow these engineering standards.

---

## 🌳 1. Branch Strategy (Git Flow)

- `main`: **Production** code. Only stable, fully tested releases are merged here via PRs from `dev`.
- `dev`: **Active Development / Staging** branch. All feature branches merge into `dev` via Pull Requests.
- `feature/<feature-name>`: New modules or features (e.g. `feature/complaint-sla`).
- `fix/<bug-name>`: Bug fixes (e.g. `fix/db-connection-timeout`).
- `chore/<task-name>`: Dependency updates, CI/CD changes.

> ⚠️ **Direct pushes to `main` and `dev` are strictly forbidden.** All code must be submitted via PR.

---

## 📝 2. Commit Message Standards (Conventional Commits)

Commit messages must follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <short description>
```

### Types:
- `feat`: A new feature (e.g., `feat(laundry): add UPI transaction reference`)
- `fix`: A bug fix (e.g., `fix(auth): handle expired delegation token`)
- `refactor`: Code changes that neither fix a bug nor add a feature
- `perf`: Performance improvement
- `ci`: CI/CD pipeline or GitHub Actions changes
- `chore`: Maintenance, dependencies, tooling updates
- `docs`: Documentation updates

---

## 🔒 3. Architecture & Security Rules

1. **Student Identifiers**:
   - Use `student_id` (`INT` referencing `students.id`) for all tables.
   - Never use Aadhaar or plain Bank codes as foreign keys.
2. **Roles & Guards**:
   - Always guard protected routes using `requireAuth`.
   - Apply role-based checks via `requireRole('platform-admin', 'leader', ...)` from `src/middleware/rbac.ts`.
3. **Environment Security**:
   - Never commit `.env` or service account credential files. Use `.env.example` as a template.
4. **Timezone**:
   - All server operations and database records must align with Indian Standard Time (`IST`, UTC+5:30) via `src/utils/time.ts`.
5. **Database**:
   - Write parameterized queries (`pool.query(sql, [params])`) to prevent SQL injection.

---

## 🚀 4. Pull Request (PR) Process

1. Create a branch from `dev`:
   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b feature/your-feature-name
   ```
2. Make your changes and test locally:
   ```bash
   npm run build
   ```
3. Commit with descriptive Conventional Commit messages.
4. Push and open a Pull Request targeting `dev`.
5. Ensure all automated CI checks in GitHub Actions pass before requesting a review.
