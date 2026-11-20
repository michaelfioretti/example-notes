// Seeds two demo users with obviously fake notes.
// Runs automatically on `npm start` when the database has no users,
// or manually with `npm run seed` (idempotent: skips users that exist).
const bcrypt = require('bcryptjs');
const db = require('./db');

// Demo-only password shared by the seeded accounts. Override with DEMO_PASSWORD.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo-password';

const DEMO_USERS = [
  {
    email: 'alice@example.com',
    notes: [
      { title: 'Alice: launch plan', body: 'Step 1: build the thing.\nStep 2: ship the thing.\nStep 3: celebrate with fake cake.' },
      { title: 'Alice: grocery list', body: 'Imaginary apples, placeholder bread, lorem ipsum cheese.' },
      { title: 'Alice: meeting notes', body: 'Discussed nothing real. Action item: keep this demo data obviously fake.' },
    ],
  },
  {
    email: 'bob@example.com',
    notes: [
      { title: 'Bob: Q3 budget', body: 'Revenue: $1,000,000 (made up)\nExpenses: $999,999 (also made up)\nProfit: $1' },
      { title: 'Bob: vacation ideas', body: 'Atlantis, El Dorado, the Moon (demo only).' },
      { title: 'Bob: book club', body: 'This month: "A Very Fictional Novel" by N. O. Body.' },
    ],
  },
];

function seed({ verbose = true } = {}) {
  const hash = bcrypt.hashSync(DEMO_PASSWORD, 12);
  const findUser = db.prepare('SELECT id FROM users WHERE email = ?');
  const insertUser = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)');
  const insertNote = db.prepare('INSERT INTO notes (user_id, title, body) VALUES (?, ?, ?)');

  const run = db.transaction(() => {
    for (const u of DEMO_USERS) {
      if (findUser.get(u.email)) {
        if (verbose) console.log(`  skip  ${u.email} (already exists)`);
        continue;
      }
      const userId = Number(insertUser.run(u.email, hash).lastInsertRowid);
      // Insert oldest-first so the first note in the list shows on top.
      [...u.notes].reverse().forEach((n) => insertNote.run(userId, n.title, n.body));
      if (verbose) console.log(`  added ${u.email} with ${u.notes.length} notes`);
    }
  });
  run();
}

function seedIfEmpty() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  if (count === 0) {
    console.log('Empty database, seeding demo users:');
    seed();
  }
}

module.exports = { seed, seedIfEmpty };

if (require.main === module) {
  console.log('Seeding demo users:');
  seed();
}
