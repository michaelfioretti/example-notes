# Notes

A small notes SaaS: sign up, log in, write notes, attach files.

**Stack:** Node.js + Express 5, SQLite (better-sqlite3), JWT auth, plain HTML/CSS/JS frontend (no build step).

## Run it

Requires Node.js 18+ (tested on 22).

```bash
npm install
npm start
```

Open http://localhost:4000.

On first start the database (`data.db`) is created and two demo users are seeded automatically.

## Demo accounts

| Email               | Password        |
|---------------------|-----------------|
| alice@example.com   | `demo-password` |
| bob@example.com     | `demo-password` |

Each has three obviously fake notes ("Alice: launch plan", "Bob: Q3 budget", …). You can also sign up a new account from the login screen.

To use a different demo password, set `DEMO_PASSWORD` before the first start (or before `npm run reset`).

## Scripts

| Command         | What it does                                                        |
|-----------------|---------------------------------------------------------------------|
| `npm start`     | Start the server on port 4000 (seeds demo users if the DB is empty) |
| `npm run seed`  | Add the demo users if they're missing (safe to re-run)              |
| `npm run reset` | Delete the database and uploads, then re-seed: a clean demo state   |

## Configuration (env vars, all optional)

| Variable        | Default                         | Notes                                                 |
|-----------------|---------------------------------|-------------------------------------------------------|
| `PORT`          | `4000`                          |                                                       |
| `JWT_SECRET`    | random, saved to `.jwt-secret`  | Set this explicitly in any real deployment            |
| `DB_PATH`       | `./data.db`                     |                                                       |
| `DEMO_PASSWORD` | `demo-password`                 | Password for the seeded demo users                    |

## API

All `/api/notes*` routes need `Authorization: Bearer <token>`.

| Method | Path                                   | Description                              |
|--------|----------------------------------------|------------------------------------------|
| POST   | `/api/auth/signup`                     | `{ email, password }` → `{ token, user }` |
| POST   | `/api/auth/login`                      | `{ email, password }` → `{ token, user }` |
| GET    | `/api/auth/me`                         | Current user                             |
| GET    | `/api/notes`                           | List your notes                          |
| POST   | `/api/notes`                           | `{ title, body }` → create               |
| GET    | `/api/notes/:id`                       | Note + its attachments                   |
| DELETE | `/api/notes/:id`                       | Delete note and its files                |
| POST   | `/api/notes/:id/attachments`           | Multipart upload, field name `file` (max 10 MB) |
| GET    | `/api/notes/:id/attachments/:attId`    | Download                                 |
| DELETE | `/api/notes/:id/attachments/:attId`    | Remove attachment                        |

Quick check with curl:

```bash
TOKEN=$(curl -s localhost:4000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"demo-password"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s localhost:4000/api/notes -H "Authorization: Bearer $TOKEN"
```

## Security notes

- Passwords are hashed with bcrypt (cost 12). Login returns the same error for unknown email and wrong password.
- Every note and attachment query is scoped to the logged-in user. Requesting someone else's note ID returns `404`, the same as a missing note, so IDs can't be probed.
- Uploads are stored in `./uploads` under random server-generated names; the original filename is only kept in the DB. Ownership is checked before the file is written. Downloads are always sent as `application/octet-stream` with `Content-Disposition: attachment`, so uploaded HTML/SVG can't run in the app's origin. `./uploads` is not served statically.
- JWTs are HS256, expire after 7 days, and are sent in the `Authorization` header (never in URLs). The frontend renders all user content with `textContent` and the server sends a strict CSP.
- Auth endpoints have a simple per-IP rate limit (30 requests / 15 min).

This is a demo: the JWT lives in `localStorage` and there's no logout-side token revocation, email verification or password reset. For production you'd want httpOnly cookies + CSRF protection, HTTPS, and a persistent rate limiter.

## Project layout

```
server.js      Express app: auth, notes, attachments
db.js          SQLite schema
seed.js        Demo users + notes
public/        index.html, app.js, style.css
uploads/       Attachment files (created at runtime)
data.db        SQLite database (created at runtime)
```
