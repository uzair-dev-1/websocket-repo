/**
 * Ticket System - WebSocket Server
 * Real-time chat and notifications
 */

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mysql = require('mysql2/promise');
const cors = require('cors');
const { sendNewMessageSMS } = require('./sms-service');

// ============================================================================
// Configuration
// ============================================================================

const PORT = process.env.WS_PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';

const dbConfig = {
  host: process.env.DB_HOST || '213.199.44.194',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'panel',
  password: process.env.DB_PASS || 'Free2play++',
  database: process.env.DB_NAME || 'account',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

// ============================================================================
// Server Setup
// ============================================================================

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json());

// Create MySQL connection pool
const pool = mysql.createPool(dbConfig);

// ============================================================================
// Data Structures
// ============================================================================

// Store active users: socketId => { userId, username, isAdmin, ticketId }
const activeUsers = new Map();

// Store admin sockets for notifications
const adminSockets = new Set();

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Log with timestamp
 */
function log(message, ...args) {
  console.log(`[${new Date().toISOString()}]`, message, ...args);
}

/**
 * Send notification to all admins
 */
function notifyAdmins(event, data) {
  adminSockets.forEach(socketId => {
    io.to(socketId).emit(event, data);
  });
  log(`Notified ${adminSockets.size} admins:`, event);
}

// ============================================================================
// Socket.IO Event Handlers
// ============================================================================

io.on('connection', (socket) => {
  log('Client connected:', socket.id);

  /**
   * User/Admin joins the system
   */
  socket.on('join_system', (data) => {
    const { userId, username, isAdmin } = data;
    
    activeUsers.set(socket.id, {
      userId,
      username,
      isAdmin: Boolean(isAdmin),
      ticketId: null
    });

    if (isAdmin) {
      adminSockets.add(socket.id);
      log(`Admin ${username} joined system`);
    } else {
      log(`User ${username} joined system`);
    }

    socket.emit('system_joined', {
      success: true,
      message: 'Connected to ticket system'
    });
  });

  /**
   * Join a specific ticket chat room
   */
  socket.on('join_ticket', (data) => {
    const { ticketId, userId, username, isAdmin } = data;
    const roomName = `ticket_${ticketId}`;
    
    socket.join(roomName);
    
    // Update user info
    const userInfo = activeUsers.get(socket.id) || {};
    userInfo.ticketId = ticketId;
    activeUsers.set(socket.id, userInfo);
    
    log(`${isAdmin ? 'Admin' : 'User'} ${username} joined ticket #${ticketId}`);
    
    // Notify others in the room
    socket.to(roomName).emit('user_joined', {
      username,
      isAdmin: Boolean(isAdmin),
      message: `${username} joined the chat`
    });
  });

  /**
   * Send a message in a ticket
   */
  socket.on('send_message', async (data) => {
    const { ticketId, userId, username, text, sender, image_url } = data;
    const roomName = `ticket_${ticketId}`;
    
    try {
      const connection = await pool.getConnection();
      try {
        // Insert message into database (with optional image_url)
        const [result] = await connection.execute(
        'INSERT INTO ticket_messages (ticket_id, sender, account_id, text, image_url) VALUES (?, ?, ?, ?, ?)',
          [ticketId, sender, userId, text || '', image_url || null]
        );
        
        const messageId = result.insertId;
        
        // Get the complete message with timestamp
        const [messages] = await connection.execute(
          'SELECT tm.*, a.login as username FROM ticket_messages tm JOIN account a ON tm.account_id = a.id WHERE tm.id = ?',
          [messageId]
        );
        
        const message = messages[0];
        
        // Broadcast message to all users in the ticket room
        io.to(roomName).emit('new_message', {
          id: message.id,
          ticket_id: message.ticket_id,
          sender: message.sender,
          username: message.username,
          text: message.text,
          image_url: message.image_url,
          created_at: message.created_at
        });
        
        log(`Message sent in ticket #${ticketId} by ${username}`);
        
        // If user sent message, notify all admins
        if (sender === 'user') {
          notifyAdmins('new_user_message', {
            ticketId,
            username,
            text,
            messageId,
            timestamp: message.created_at
          });
        }
        
        // If admin sent message, notify the ticket owner and send SMS
        if (sender === 'admin') {
          // Get ticket owner ID and SMS preferences from database
          const [ticketData] = await connection.execute(
            'SELECT account_id, phone, sms_requested FROM tickets WHERE id = ?',
            [ticketId]
          );
          
          if (ticketData.length > 0) {
            const ticket = ticketData[0];
            const ownerId = ticket.account_id;
            
            // Find owner's socket(s) and notify them
            const ownerSockets = Array.from(activeUsers.entries())
              .filter(([socketId, user]) => Number(user.userId) === Number(ownerId) && !user.isAdmin)
              .map(([socketId]) => socketId);
            
            ownerSockets.forEach(socketId => {
              io.to(socketId).emit('new_admin_message', {
                ticketId,
                username,
                text,
                messageId,
                timestamp: message.created_at
              });
            });
            
            log(`Notified ticket #${ticketId} owner about new admin message (${ownerSockets.length} connections)`);
            
            // DO NOT send automatic SMS - admin will send manually
            // SMS will only be sent when admin clicks "Send SMS" button
          }
        }
        
      } finally {
        connection.release();
      }
      
    } catch (error) {
      log('Error sending message:', error);
      socket.emit('message_error', {
        error: 'Failed to send message'
      });
    }
  });

  /**
   * Typing indicator
   */
  socket.on('typing', (data) => {
    const { ticketId, username } = data;
    socket.to(`ticket_${ticketId}`).emit('user_typing', { username });
  });

  /**
   * Stop typing indicator
   */
  socket.on('stop_typing', (data) => {
    const { ticketId } = data;
    socket.to(`ticket_${ticketId}`).emit('user_stop_typing');
  });

  /**
   * New ticket created - notify admins
   */
  socket.on('ticket_created', async (data) => {
    const { ticketId, title, category, username } = data;
    
    log(`New ticket #${ticketId} created by ${username}`);
    
    // Notify all admins about new ticket
    notifyAdmins('new_ticket', {
      ticketId,
      title,
      category,
      username,
      timestamp: new Date().toISOString()
    });
  });

  /**
   * Ticket status updated - notify ticket owner and admins
   */
  socket.on('status_updated', async (data) => {
    const { ticketId, oldStatus, newStatus, updatedBy } = data;
    const roomName = `ticket_${ticketId}`;
    
    log(`Ticket #${ticketId} status changed from ${oldStatus} to ${newStatus} by ${updatedBy}`);
    
    try {
      const connection = await pool.getConnection();
      
      try {
        // Get ticket details and owner info
        const [tickets] = await connection.execute(
          'SELECT t.*, a.login as username FROM tickets t JOIN account a ON t.account_id = a.id WHERE t.id = ?',
          [ticketId]
        );
        
        if (tickets.length > 0) {
          const ticket = tickets[0];
          
          // Notify everyone in the ticket room
          io.to(roomName).emit('ticket_status_changed', {
            ticketId,
            oldStatus,
            newStatus,
            updatedBy,
            timestamp: new Date().toISOString()
          });
          
          // Notify the ticket owner if they're not in the room
          const ownerSockets = Array.from(activeUsers.entries())
            .filter(([socketId, user]) => user.userId === ticket.account_id && user.ticketId !== ticketId)
            .map(([socketId]) => socketId);
          
          ownerSockets.forEach(socketId => {
            io.to(socketId).emit('ticket_status_changed', {
              ticketId,
              title: ticket.title,
              oldStatus,
              newStatus,
              updatedBy,
              timestamp: new Date().toISOString()
            });
          });
          
          log(`Notified ticket #${ticketId} owner and participants about status change`);
        }
      } finally {
        connection.release();
      }
      
    } catch (error) {
      log('Error processing status update:', error);
    }
  });

  /**
   * Leave ticket room
   */
  socket.on('leave_ticket', (data) => {
    const { ticketId, username } = data;
    const roomName = `ticket_${ticketId}`;
    
    socket.leave(roomName);
    socket.to(roomName).emit('user_left', {
      username,
      message: `${username} left the chat`
    });
    
    log(`User ${username} left ticket #${ticketId}`);
  });

  /**
   * Disconnect
   */
  socket.on('disconnect', () => {
    const user = activeUsers.get(socket.id);
    
    if (user) {
      if (user.ticketId) {
        socket.to(`ticket_${user.ticketId}`).emit('user_left', {
          username: user.username,
          message: `${user.username} left the chat`
        });
      }
      
      if (user.isAdmin) {
        adminSockets.delete(socket.id);
        log(`Admin ${user.username} disconnected`);
      } else {
        log(`User ${user.username} disconnected`);
      }
      
      activeUsers.delete(socket.id);
    }
    
    log('Client disconnected:', socket.id);
  });
});

// ============================================================================
// REST API Endpoints
// ============================================================================

/**
 * Get messages for a ticket
 */
app.get('/api/messages/:ticketId', async (req, res) => {
  const { ticketId } = req.params;
  
  try {
    const connection = await pool.getConnection();
    
    try {
      const [messages] = await connection.execute(
        `SELECT tm.*, a.login as username 
         FROM ticket_messages tm 
         JOIN account a ON tm.account_id = a.id 
         WHERE tm.ticket_id = ? 
         ORDER BY tm.created_at ASC`,
        [ticketId]
      );
      
      res.json({ success: true, messages });
    } finally {
      connection.release();
    }
  } catch (error) {
    log('Error fetching messages:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch messages' });
  }
});

/**
 * Broadcast status update notification
 */
app.post('/api/broadcast-status-update', async (req, res) => {
  const { ticketId, oldStatus, newStatus, updatedBy } = req.body;
  
  if (!ticketId || !newStatus) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }
  
  try {
    const connection = await pool.getConnection();
    
    try {
      // Get ticket details
      const [tickets] = await connection.execute(
        'SELECT t.*, a.login as username FROM tickets t JOIN account a ON t.account_id = a.id WHERE t.id = ?',
        [ticketId]
      );
      
      if (tickets.length === 0) {
        return res.status(404).json({ success: false, error: 'Ticket not found' });
      }
      
      const ticket = tickets[0];
      const roomName = `ticket_${ticketId}`;
      
      // Notify ONLY the ticket owner (not admins)
      const ownerSockets = Array.from(activeUsers.entries())
        .filter(([socketId, user]) => Number(user.userId) === Number(ticket.account_id) && !user.isAdmin)
        .map(([socketId]) => socketId);
      
      log(`Looking for owner of ticket #${ticketId}, account_id: ${ticket.account_id}, found ${ownerSockets.length} connections`);
      
      ownerSockets.forEach(socketId => {
        io.to(socketId).emit('ticket_status_changed', {
          ticketId,
          title: ticket.title,
          oldStatus,
          newStatus,
          updatedBy,
          timestamp: new Date().toISOString()
        });
      });
      
      log(`Notified ticket #${ticketId} owner about status change: ${oldStatus} -> ${newStatus} (${ownerSockets.length} connections)`);
      
      res.json({ 
        success: true, 
        message: 'Status update broadcasted',
        notified: ownerSockets.length
      });
      
    } finally {
      connection.release();
    }
  } catch (error) {
    log('Error broadcasting status update:', error);
    res.status(500).json({ success: false, error: 'Failed to broadcast status update' });
  }
});

/**
 * Health check
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeUsers: activeUsers.size,
    adminCount: adminSockets.size,
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// Start Server
// ============================================================================

server.listen(PORT, () => {
  log(`✅ WebSocket server running on port ${PORT}`);
  log(`📡 CORS origin: ${CORS_ORIGIN}`);
  log(`💾 Database: ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
  
  // Test database connection
  pool.getConnection()
    .then(connection => {
      log('✅ Database connection successful');
      connection.release();
    })
    .catch(error => {
      log('❌ Database connection failed:', error.message);
    });
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  log('SIGTERM received, closing server...');
  server.close(() => {
    log('Server closed');
    pool.end();
    process.exit(0);
  });
});
