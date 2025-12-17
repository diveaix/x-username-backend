const express = require('express');
const cors = require('cors');
const { createClient } = require('@libsql/client');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Turso client
let db;
try {
  db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
} catch (error) {
  console.error('Failed to create database client:', error);
}

// Initialize database tables
async function initDatabase() {
  if (!db) return;
  
  try {
    await db.execute(`
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
    console.log('Database initialized');
  } catch (error) {
    console.error('Database init error:', error);
  }
}

// Initialize on first request
let dbInitialized = false;

// Middleware to ensure DB is initialized
app.use(async (req, res, next) => {
  if (!dbInitialized) {
    await initDatabase();
    dbInitialized = true;
  }
  next();
});

// ============= API ROUTES =============

// Root route
app.get('/', (req, res) => {
  res.json({ message: 'X Username Manager API', status: 'running' });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GET all usernames
app.get('/api/usernames', async (req, res) => {
  try {
    const { list_type } = req.query;
    
    let result;
    
    if (list_type && ['following', 'followers'].includes(list_type)) {
      result = await db.execute({
        sql: 'SELECT * FROM usernames WHERE list_type = ? ORDER BY created_at DESC',
        args: [list_type]
      });
    } else {
      result = await db.execute('SELECT * FROM usernames ORDER BY list_type, created_at DESC');
    }
    
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching usernames:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch usernames' });
  }
});

// GET single username by ID
app.get('/api/usernames/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.execute({
      sql: 'SELECT * FROM usernames WHERE id = ?',
      args: [id]
    });
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Username not found' });
    }
    
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error fetching username:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch username' });
  }
});

// POST create new username
app.post('/api/usernames', async (req, res) => {
  try {
    const { username, list_type, display_name, notes } = req.body;
    
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
    
    const cleanUsername = username.replace(/^@/, '').trim().toLowerCase();
    
    if (!cleanUsername) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid username' 
      });
    }
    
    // Check if exists
    const existing = await db.execute({
      sql: 'SELECT id FROM usernames WHERE username = ? AND list_type = ?',
      args: [cleanUsername, list_type]
    });
    
    if (existing.rows.length > 0) {
      return res.status(409).json({ 
        success: false, 
        error: `Username @${cleanUsername} already exists in ${list_type} list` 
      });
    }
    
    const result = await db.execute({
      sql: 'INSERT INTO usernames (username, list_type, display_name, notes) VALUES (?, ?, ?, ?)',
      args: [cleanUsername, list_type, display_name || null, notes || null]
    });
    
    const newUsername = await db.execute({
      sql: 'SELECT * FROM usernames WHERE id = ?',
      args: [result.lastInsertRowid]
    });
    
    res.status(201).json({ success: true, data: newUsername.rows[0] });
  } catch (error) {
    console.error('Error creating username:', error);
    res.status(500).json({ success: false, error: 'Failed to create username' });
  }
});

// PUT update username
app.put('/api/usernames/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { username, list_type, display_name, notes } = req.body;
    
    const existingResult = await db.execute({
      sql: 'SELECT * FROM usernames WHERE id = ?',
      args: [id]
    });
    
    if (existingResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Username not found' });
    }
    
    const existing = existingResult.rows[0];
    const cleanUsername = username ? username.replace(/^@/, '').trim().toLowerCase() : existing.username;
    const newListType = list_type || existing.list_type;
    
    await db.execute({
      sql: 'UPDATE usernames SET username = ?, list_type = ?, display_name = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      args: [
        cleanUsername,
        newListType,
        display_name !== undefined ? display_name : existing.display_name,
        notes !== undefined ? notes : existing.notes,
        id
      ]
    });
    
    const updated = await db.execute({
      sql: 'SELECT * FROM usernames WHERE id = ?',
      args: [id]
    });
    
    res.json({ success: true, data: updated.rows[0] });
  } catch (error) {
    console.error('Error updating username:', error);
    res.status(500).json({ success: false, error: 'Failed to update username' });
  }
});

// DELETE username
app.delete('/api/usernames/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const existing = await db.execute({
      sql: 'SELECT * FROM usernames WHERE id = ?',
      args: [id]
    });
    
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Username not found' });
    }
    
    await db.execute({
      sql: 'DELETE FROM usernames WHERE id = ?',
      args: [id]
    });
    
    res.json({ success: true, message: 'Username deleted successfully' });
  } catch (error) {
    console.error('Error deleting username:', error);
    res.status(500).json({ success: false, error: 'Failed to delete username' });
  }
});

// Bulk import usernames
app.post('/api/usernames/bulk', async (req, res) => {
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
      const cleanUsername = String(user).replace(/^@/, '').trim().toLowerCase();
      if (cleanUsername) {
        try {
          await db.execute({
            sql: 'INSERT OR IGNORE INTO usernames (username, list_type) VALUES (?, ?)',
            args: [cleanUsername, list_type]
          });
          inserted++;
        } catch (e) {
          // Skip duplicates
        }
      }
    }
    
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
app.get('/api/search', async (req, res) => {
  try {
    const { q, list_type } = req.query;
    
    if (!q) {
      return res.status(400).json({ success: false, error: 'Search query is required' });
    }
    
    const searchTerm = `%${q}%`;
    let result;
    
    if (list_type && ['following', 'followers'].includes(list_type)) {
      result = await db.execute({
        sql: `SELECT * FROM usernames 
              WHERE (username LIKE ? OR display_name LIKE ? OR notes LIKE ?)
              AND list_type = ?
              ORDER BY created_at DESC`,
        args: [searchTerm, searchTerm, searchTerm, list_type]
      });
    } else {
      result = await db.execute({
        sql: `SELECT * FROM usernames 
              WHERE username LIKE ? OR display_name LIKE ? OR notes LIKE ?
              ORDER BY list_type, created_at DESC`,
        args: [searchTerm, searchTerm, searchTerm]
      });
    }
    
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error searching:', error);
    res.status(500).json({ success: false, error: 'Failed to search usernames' });
  }
});

// Get stats
app.get('/api/stats', async (req, res) => {
  try {
    const followingResult = await db.execute({
      sql: 'SELECT COUNT(*) as count FROM usernames WHERE list_type = ?',
      args: ['following']
    });
    const followersResult = await db.execute({
      sql: 'SELECT COUNT(*) as count FROM usernames WHERE list_type = ?',
      args: ['followers']
    });
    
    const following = Number(followingResult.rows[0]?.count || 0);
    const followers = Number(followersResult.rows[0]?.count || 0);
    
    res.json({
      success: true,
      data: {
        following,
        followers,
        total: following + followers
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

// For local development
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

// Export for Vercel
module.exports = app;
