#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
#  demo/setup-sample-repo.sh
#
#  Creates a realistic Express.js API at ~/demos/zizou-sample-repo that is:
#    - Large enough to look like a real project
#    - Missing JWT auth (so Zizou has something meaningful to add)
#    - Has passing tests before Zizou touches anything
#    - Committed to git so "git diff --stat" looks satisfying after the demo
#
#  Usage:
#    bash demo/setup-sample-repo.sh
#
#  Re-run at any time to reset the repo to a clean demo state.
# ══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

DEMO_DIR="$HOME/demos/zizou-sample-repo"

echo "→ Removing old demo repo (if any)…"
rm -rf "$DEMO_DIR"
mkdir -p "$DEMO_DIR"
cd "$DEMO_DIR"

# ─── git init ────────────────────────────────────────────────────────────────
git init -q
git config user.email "demo@zizou.dev"
git config user.name  "Zizou Demo"

# ─── package.json ─────────────────────────────────────────────────────────────
cat > package.json << 'EOF'
{
  "name": "taskflow-api",
  "version": "1.0.0",
  "description": "A task management REST API built with Express",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "dev": "nodemon src/server.js",
    "test": "jest --runInBand --forceExit"
  },
  "dependencies": {
    "express": "^4.18.2",
    "express-validator": "^7.0.1",
    "mongoose": "^8.0.3",
    "redis": "^4.6.10",
    "winston": "^3.11.0",
    "cors": "^2.8.5",
    "helmet": "^7.1.0",
    "morgan": "^1.10.0",
    "dotenv": "^16.3.1"
  },
  "devDependencies": {
    "jest": "^29.7.0",
    "supertest": "^6.3.3",
    "nodemon": "^3.0.2"
  },
  "jest": {
    "testEnvironment": "node",
    "testMatch": ["**/tests/**/*.test.js"]
  }
}
EOF

# ─── Directory structure ──────────────────────────────────────────────────────
mkdir -p src/{routes,models,middleware,config,utils}
mkdir -p tests

# ─── src/server.js ────────────────────────────────────────────────────────────
cat > src/server.js << 'EOF'
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');

const taskRoutes = require('./routes/tasks');
const userRoutes = require('./routes/users');
const logger     = require('./utils/logger');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/tasks', taskRoutes);
app.use('/api/users', userRoutes);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error(err.message);
  res.status(500).json({ error: err.message });
});

if (require.main === module) {
  app.listen(PORT, () => logger.info(`TaskFlow API running on :${PORT}`));
}

module.exports = app;
EOF

# ─── src/models/user.js ───────────────────────────────────────────────────────
cat > src/models/user.js << 'EOF'
// Lightweight in-memory user store for the demo.
// A real app would use Mongoose / PostgreSQL here.

const users = [
  { id: 1, email: 'alice@example.com', password: '$2b$10$placeholder', role: 'admin' },
  { id: 2, email: 'bob@example.com',   password: '$2b$10$placeholder', role: 'user'  },
];

let nextId = 3;

module.exports = {
  findByEmail: (email) => users.find(u => u.email === email) || null,
  findById:    (id)    => users.find(u => u.id === id)    || null,
  create:      (data)  => {
    const user = { id: nextId++, ...data };
    users.push(user);
    return user;
  },
  all: () => [...users],
};
EOF

# ─── src/models/task.js ───────────────────────────────────────────────────────
cat > src/models/task.js << 'EOF'
const tasks = [];
let nextId = 1;

module.exports = {
  findAll:  ()           => [...tasks],
  findById: (id)         => tasks.find(t => t.id === id) || null,
  create:   (data)       => { const t = { id: nextId++, ...data, createdAt: new Date() }; tasks.push(t); return t; },
  update:   (id, patch)  => {
    const i = tasks.findIndex(t => t.id === id);
    if (i === -1) return null;
    tasks[i] = { ...tasks[i], ...patch };
    return tasks[i];
  },
  remove:   (id)         => {
    const i = tasks.findIndex(t => t.id === id);
    if (i === -1) return false;
    tasks.splice(i, 1);
    return true;
  },
};
EOF

# ─── src/routes/tasks.js ─────────────────────────────────────────────────────
cat > src/routes/tasks.js << 'EOF'
const router = require('express').Router();
const Task   = require('../models/task');

router.get('/',      (_req, res) => res.json(Task.findAll()));
router.get('/:id',   (req, res)  => {
  const task = Task.findById(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Not found' });
  res.json(task);
});
router.post('/',     (req, res)  => res.status(201).json(Task.create(req.body)));
router.put('/:id',   (req, res)  => {
  const task = Task.update(Number(req.params.id), req.body);
  if (!task) return res.status(404).json({ error: 'Not found' });
  res.json(task);
});
router.delete('/:id', (req, res) => {
  if (!Task.remove(Number(req.params.id))) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});

module.exports = router;
EOF

# ─── src/routes/users.js ─────────────────────────────────────────────────────
cat > src/routes/users.js << 'EOF'
const router = require('express').Router();
const User   = require('../models/user');

// Public profile listing — no auth needed yet
router.get('/', (_req, res) => {
  const safe = User.all().map(({ id, email, role }) => ({ id, email, role }));
  res.json(safe);
});

module.exports = router;
EOF

# ─── src/utils/logger.js ─────────────────────────────────────────────────────
cat > src/utils/logger.js << 'EOF'
// Minimal console logger shim (real app would use winston)
module.exports = {
  info:  (...args) => console.log('[INFO]',  ...args),
  warn:  (...args) => console.warn('[WARN]',  ...args),
  error: (...args) => console.error('[ERROR]', ...args),
};
EOF

# ─── src/config/index.js ──────────────────────────────────────────────────────
cat > src/config/index.js << 'EOF'
require('dotenv').config();

module.exports = {
  port:        process.env.PORT  || 3000,
  jwtSecret:   process.env.JWT_SECRET  || 'change-me-in-production',
  jwtExpiry:   process.env.JWT_EXPIRY  || '15m',
  redisUrl:    process.env.REDIS_URL   || null,
};
EOF

# ─── .env ─────────────────────────────────────────────────────────────────────
cat > .env << 'EOF'
PORT=3000
JWT_SECRET=super-secret-dev-key-do-not-commit
JWT_EXPIRY=15m
REDIS_URL=
EOF

# ─── .gitignore ───────────────────────────────────────────────────────────────
cat > .gitignore << 'EOF'
node_modules/
.env
*.log
coverage/
EOF

# ─── tests/tasks.test.js ─────────────────────────────────────────────────────
cat > tests/tasks.test.js << 'EOF'
const request = require('supertest');
const app     = require('../src/server');

describe('Tasks API', () => {
  let taskId;

  it('GET /api/tasks returns empty array initially', async () => {
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/tasks creates a task', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'Write demo', done: false });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Write demo');
    taskId = res.body.id;
  });

  it('GET /api/tasks/:id returns the task', async () => {
    const res = await request(app).get(`/api/tasks/${taskId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(taskId);
  });

  it('PUT /api/tasks/:id updates the task', async () => {
    const res = await request(app)
      .put(`/api/tasks/${taskId}`)
      .send({ done: true });
    expect(res.status).toBe(200);
    expect(res.body.done).toBe(true);
  });

  it('DELETE /api/tasks/:id removes the task', async () => {
    const res = await request(app).delete(`/api/tasks/${taskId}`);
    expect(res.status).toBe(204);
  });

  it('GET /api/tasks/:id returns 404 for missing task', async () => {
    const res = await request(app).get('/api/tasks/99999');
    expect(res.status).toBe(404);
  });

  it('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
EOF

# ─── tests/users.test.js ─────────────────────────────────────────────────────
cat > tests/users.test.js << 'EOF'
const request = require('supertest');
const app     = require('../src/server');

describe('Users API', () => {
  it('GET /api/users lists users without passwords', async () => {
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    res.body.forEach(u => expect(u.password).toBeUndefined());
  });
});
EOF

# ─── README.md ────────────────────────────────────────────────────────────────
cat > README.md << 'EOF'
# TaskFlow API

A simple task management REST API built with Express.js.

## Endpoints

| Method | Path              | Description              |
|--------|-------------------|--------------------------|
| GET    | /api/tasks        | List all tasks           |
| POST   | /api/tasks        | Create a task            |
| GET    | /api/tasks/:id    | Get task by ID           |
| PUT    | /api/tasks/:id    | Update task              |
| DELETE | /api/tasks/:id    | Delete task              |
| GET    | /api/users        | List users (public info) |
| GET    | /health           | Health check             |

## TODO

- [ ] JWT authentication
- [ ] Rate limiting
- [ ] Request logging to file
EOF

# ─── Initial commit ───────────────────────────────────────────────────────────
echo "→ Installing npm dependencies…"
npm install --silent

echo "→ Committing initial state…"
git add -A
git commit -q -m "feat: initial TaskFlow API with tasks + users endpoints"

echo ""
echo "✓  Demo repo ready at $DEMO_DIR"
echo "   Run: vhs demo/zizou_demo.tape"
