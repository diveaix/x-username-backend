const express = require('express');
const cors = require('cors');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Database file path
const dbPath = path.join(__dirname, 'usernames.db');

let db;

// Initialize database
async function initDatabase() {
  const SQL = await initSqlJs();
  
  // Load existing database or create new one
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
    console.log('✅ Loaded existing database');
  } else {
    db = new SQL.Database();
    console.log('✅ Created new database');
  }
  
  // Create tables if they don't exist
  db.run(`
    CREATE TABLE IF NOT EXISTS usernames (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      list_type TEXT NOT NULL CHECK(list_type IN ('following', 'followers')),
      display_name TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(username, list_type)
    )
  `);
  
  db.run(`CREATE INDEX IF NOT EXISTS idx_list_type ON usernames(list_type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_username ON usernames(username)`);
  
  saveDatabase();
}

// Save database to file
function saveDatabase() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

// Helper to run SELECT queries and return results as array of objects
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

// Helper to run SELECT query and return single result
function queryOne(sql, params = []) {
  const results = queryAll(sql, params);
  return results.length > 0 ? results[0] : null;
}

// Helper to run INSERT/UPDATE/DELETE
function run(sql, params = []) {
  db.run(sql, params);
  saveDatabase();
  return {
    lastInsertRowid: db.exec("SELECT last_insert_rowid()")[0]?.values[0][0],
    changes: db.getRowsModified()
  };
}

// ============= API ROUTES =============

// GET all usernames (optionally filter by list_type)
app.get('/api/usernames', (req, res) => {
  try {
    const { list_type } = req.query;
    
    let usernames;
    
    if (list_type && ['following', 'followers'].includes(list_type)) {
      usernames = queryAll('SELECT * FROM usernames WHERE list_type = ? ORDER BY created_at DESC', [list_type]);
    } else {
      usernames = queryAll('SELECT * FROM usernames ORDER BY list_type, created_at DESC');
    }
    
    res.json({ success: true, data: usernames });
  } catch (error) {
    console.error('Error fetching usernames:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch usernames' });
  }
});

// GET single username by ID
app.get('/api/usernames/:id', (req, res) => {
  try {
    const { id } = req.params;
    const username = queryOne('SELECT * FROM usernames WHERE id = ?', [id]);
    
    if (!username) {
      return res.status(404).json({ success: false, error: 'Username not found' });
    }
    
    res.json({ success: true, data: username });
  } catch (error) {
    console.error('Error fetching username:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch username' });
  }
});

// POST create new username
app.post('/api/usernames', (req, res) => {
  try {
    const { username, list_type, display_name, notes } = req.body;
    
    // Validation
    if (!username || !list_type) {
      return res.status(400).json({ 
        success: false, 
        error: 'Username and list_type are required' 
      });
    }
    
    if (!['following', 'followers'].includes(list_type)) {
      return res.status(400).json({ 
        success: false, 
        error: 'list_type must be either "following" or "followers"' 
      });
    }
    
    // Clean the username (remove @ if present)
    const cleanUsername = username.replace(/^@/, '').trim().toLowerCase();
    
    if (!cleanUsername) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid username' 
      });
    }
    
    // Check if username already exists in this list
    const existing = queryOne('SELECT id FROM usernames WHERE username = ? AND list_type = ?', [cleanUsername, list_type]);
    
    if (existing) {
      return res.status(409).json({ 
        success: false, 
        error: `Username @${cleanUsername} already exists in ${list_type} list` 
      });
    }
    
    const result = run(
      `INSERT INTO usernames (username, list_type, display_name, notes) VALUES (?, ?, ?, ?)`,
      [cleanUsername, list_type, display_name || null, notes || null]
    );
    
    const newUsername = queryOne('SELECT * FROM usernames WHERE id = ?', [result.lastInsertRowid]);
    
    res.status(201).json({ success: true, data: newUsername });
  } catch (error) {
    console.error('Error creating username:', error);
    res.status(500).json({ success: false, error: 'Failed to create username' });
  }
});

// PUT update username
app.put('/api/usernames/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { username, list_type, display_name, notes } = req.body;
    
    // Check if username exists
    const existing = queryOne('SELECT * FROM usernames WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Username not found' });
    }
    
    const cleanUsername = username ? username.replace(/^@/, '').trim().toLowerCase() : existing.username;
    const newListType = list_type || existing.list_type;
    
    if (list_type && !['following', 'followers'].includes(list_type)) {
      return res.status(400).json({ 
        success: false, 
        error: 'list_type must be either "following" or "followers"' 
      });
    }
    
    run(
      `UPDATE usernames SET username = ?, list_type = ?, display_name = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [
        cleanUsername,
        newListType,
        display_name !== undefined ? display_name : existing.display_name,
        notes !== undefined ? notes : existing.notes,
        id
      ]
    );
    
    const updated = queryOne('SELECT * FROM usernames WHERE id = ?', [id]);
    
    res.json({ success: true, data: updated });
  } catch (error) {
    console.error('Error updating username:', error);
    res.status(500).json({ success: false, error: 'Failed to update username' });
  }
});

// DELETE username
app.delete('/api/usernames/:id', (req, res) => {
  try {
    const { id } = req.params;
    
    const existing = queryOne('SELECT * FROM usernames WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Username not found' });
    }
    
    run('DELETE FROM usernames WHERE id = ?', [id]);
    
    res.json({ success: true, message: 'Username deleted successfully' });
  } catch (error) {
    console.error('Error deleting username:', error);
    res.status(500).json({ success: false, error: 'Failed to delete username' });
  }
});

// DELETE all usernames in a list
app.delete('/api/usernames/list/:list_type', (req, res) => {
  try {
    const { list_type } = req.params;
    
    if (!['following', 'followers'].includes(list_type)) {
      return res.status(400).json({ 
        success: false, 
        error: 'list_type must be either "following" or "followers"' 
      });
    }
    
    const result = run('DELETE FROM usernames WHERE list_type = ?', [list_type]);
    
    res.json({ 
      success: true, 
      message: `Deleted ${result.changes} usernames from ${list_type} list` 
    });
  } catch (error) {
    console.error('Error deleting list:', error);
    res.status(500).json({ success: false, error: 'Failed to delete list' });
  }
});

// Bulk import usernames
app.post('/api/usernames/bulk', (req, res) => {
  try {
    const { usernames, list_type } = req.body;
    
    if (!Array.isArray(usernames) || !list_type) {
      return res.status(400).json({ 
        success: false, 
        error: 'usernames array and list_type are required' 
      });
    }
    
    if (!['following', 'followers'].includes(list_type)) {
      return res.status(400).json({ 
        success: false, 
        error: 'list_type must be either "following" or "followers"' 
      });
    }
    
    let inserted = 0;
    for (const user of usernames) {
      const cleanUsername = user.replace(/^@/, '').trim().toLowerCase();
      if (cleanUsername) {
        try {
          db.run(
            `INSERT OR IGNORE INTO usernames (username, list_type) VALUES (?, ?)`,
            [cleanUsername, list_type]
          );
          if (db.getRowsModified() > 0) inserted++;
        } catch (e) {
          // Skip duplicates
        }
      }
    }
    saveDatabase();
    
    res.status(201).json({ 
      success: true, 
      message: `Imported ${inserted} usernames`,
      imported: inserted,
      total: usernames.length
    });
  } catch (error) {
    console.error('Error bulk importing:', error);
    res.status(500).json({ success: false, error: 'Failed to import usernames' });
  }
});

// Search usernames
app.get('/api/search', (req, res) => {
  try {
    const { q, list_type } = req.query;
    
    if (!q) {
      return res.status(400).json({ success: false, error: 'Search query is required' });
    }
    
    let results;
    const searchTerm = `%${q}%`;
    
    if (list_type && ['following', 'followers'].includes(list_type)) {
      results = queryAll(
        `SELECT * FROM usernames 
         WHERE (username LIKE ? OR display_name LIKE ? OR notes LIKE ?)
         AND list_type = ?
         ORDER BY created_at DESC`,
        [searchTerm, searchTerm, searchTerm, list_type]
      );
    } else {
      results = queryAll(
        `SELECT * FROM usernames 
         WHERE username LIKE ? OR display_name LIKE ? OR notes LIKE ?
         ORDER BY list_type, created_at DESC`,
        [searchTerm, searchTerm, searchTerm]
      );
    }
    
    res.json({ success: true, data: results });
  } catch (error) {
    console.error('Error searching:', error);
    res.status(500).json({ success: false, error: 'Failed to search usernames' });
  }
});

// Get stats
app.get('/api/stats', (req, res) => {
  try {
    const followingCount = queryOne('SELECT COUNT(*) as count FROM usernames WHERE list_type = ?', ['following']);
    const followersCount = queryOne('SELECT COUNT(*) as count FROM usernames WHERE list_type = ?', ['followers']);
    
    res.json({
      success: true,
      data: {
        following: followingCount?.count || 0,
        followers: followersCount?.count || 0,
        total: (followingCount?.count || 0) + (followersCount?.count || 0)
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server after database is initialized
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`
  ╔═══════════════════════════════════════════════════╗
  ║                                                   ║
  ║   🐦 X Username Manager API                       ║
  ║                                                   ║
  ║   Server running on http://localhost:${PORT}         ║
  ║   Database: ${dbPath}
  ║                                                   ║
  ╚═══════════════════════════════════════════════════╝
    `);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🔴 Shutting down gracefully...');
  if (db) {
    saveDatabase();
    db.close();
  }
  process.exit(0);
});