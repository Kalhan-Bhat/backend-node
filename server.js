/**
 * Node.js Gateway Server for Student Engagement Portal
 * 
 * This server acts as the central hub that:
 * 1. Serves Agora tokens for video calls
 * 2. Receives video frames from students via WebSocket
 * 3. Forwards frames to Python ML service for emotion detection
 * 4. Broadcasts emotion data to teacher dashboard in real-time
 * 5. Manages authentication and session data
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Configure allowed origins for CORS
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'https://frontend-beige-one-81.vercel.app',
  process.env.FRONTEND_URL,
  /https:\/\/.*\.vercel\.app$/  // Allow all Vercel preview and production URLs
].filter(Boolean);

// Configure Socket.IO with CORS
const io = socketIO(server, {
  cors: {
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Postman, etc.)
      if (!origin) return callback(null, true);
      
      // Check if origin matches any allowed pattern
      const isAllowed = allowedOrigins.some(allowed => {
        if (typeof allowed === 'string') {
          return origin === allowed || origin === allowed + '/';
        }
        if (allowed instanceof RegExp) {
          return allowed.test(origin);
        }
        return false;
      });
      
      if (isAllowed) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Middleware
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    
    const isAllowed = allowedOrigins.some(allowed => {
      if (typeof allowed === 'string') {
        return origin === allowed || origin === allowed + '/';
      }
      if (allowed instanceof RegExp) {
        return allowed.test(origin);
      }
      return false;
    });
    
    if (isAllowed) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Add explicit CORS headers for all requests
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    const isAllowed = allowedOrigins.some(allowed => {
      if (typeof allowed === 'string') {
        return origin === allowed || origin === allowed + '/';
      }
      if (allowed instanceof RegExp) {
        return allowed.test(origin);
      }
      return false;
    });
    
    if (isAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
  }
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

app.use(express.json({ limit: '50mb' })); // Increased limit for base64 images
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configuration from environment variables
const CONFIG = {
  AGORA_APP_ID: process.env.AGORA_APP_ID,
  AGORA_APP_CERTIFICATE: process.env.AGORA_APP_CERTIFICATE,
  PORT: process.env.PORT || 3000,
  ML_SERVICE_URL: process.env.ML_SERVICE_URL || 'http://localhost:8000'
};

// In-memory storage for active sessions
// In production, use Redis or a database
const activeSessions = {
  students: new Map(), // studentId -> { socketId, channelName, emotion, timestamp }
  teachers: new Map()  // teacherId -> { socketId, channelName }
};

// Analytics storage: channelName -> [{ timestamp, studentId, engagement, emotion }]
const analyticsData = new Map();

// Topic tracking: channelName -> [{ topicName, startTime, endTime }]
const topicTracking = new Map();

// Emotion to Engagement State Mapping
const emotionToEngagement = {
  'happy': 'Engaged',
  'neutral': 'Not Paying Attention',
  'sad': 'Bored',
  'angry': 'Confused',
  'surprised': 'Engaged',
  'fearful': 'Confused',
  'disgusted': 'Bored'
};

function mapEmotionToEngagement(emotion) {
  return emotionToEngagement[emotion] || 'Not Paying Attention';
}

// =====================================
// REST API ENDPOINTS
// =====================================

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

/**
 * Generate Agora RTC token for video calls
 * Query params: channel (required), role (optional: student/teacher)
 */
app.get('/api/token', (req, res) => {
  try {
    const { channel, role = 'student' } = req.query;
    
    if (!channel) {
      return res.status(400).json({ error: 'Channel name is required' });
    }

    // Generate unique UID for this user
    const uid = Math.floor(Math.random() * 100000);
    
    // Set token expiration (1 hour)
    const rtcRole = RtcRole.PUBLISHER;
    const expireTime = 3600;
    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpireTime = currentTime + expireTime;

    // Build Agora token
    const token = RtcTokenBuilder.buildTokenWithUid(
      CONFIG.AGORA_APP_ID,
      CONFIG.AGORA_APP_CERTIFICATE,
      channel,
      uid,
      rtcRole,
      privilegeExpireTime
    );

    console.log(`✅ Token generated for ${role} in channel: ${channel}`);
    
    res.json({
      token,
      uid,
      appId: CONFIG.AGORA_APP_ID,
      channelName: channel
    });
  } catch (error) {
    console.error('❌ Error generating token:', error);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

/**
 * Get list of students in a channel (for teacher dashboard)
 */
app.get('/api/students/:channelName', (req, res) => {
  const { channelName } = req.params;
  
  const studentsInChannel = Array.from(activeSessions.students.values())
    .filter(student => student.channelName === channelName)
    .map(student => ({
      id: student.id,
      emotion: student.emotion,
      confidence: student.confidence,
      timestamp: student.timestamp
    }));

  res.json({ students: studentsInChannel });
});

/**
 * Get analytics data for a channel
 */
app.get('/api/analytics/:channelName', (req, res) => {
  const { channelName } = req.params;
  const data = analyticsData.get(channelName) || [];
  res.json({ analytics: data });
});

/**
 * Add a topic for tracking
 */
app.post('/api/topics/:channelName', (req, res) => {
  const { channelName } = req.params;
  const { topicName } = req.body;
  
  if (!topicTracking.has(channelName)) {
    topicTracking.set(channelName, []);
  }
  
  const topic = {
    topicName,
    startTime: Date.now(),
    endTime: null
  };
  
  topicTracking.get(channelName).push(topic);
  console.log(`📚 Topic started in ${channelName}: ${topicName}`);
  
  res.json({ success: true, topic });
});

/**
 * End current topic
 */
app.put('/api/topics/:channelName/end', (req, res) => {
  const { channelName } = req.params;
  const topics = topicTracking.get(channelName);
  
  if (topics && topics.length > 0) {
    const lastTopic = topics[topics.length - 1];
    if (!lastTopic.endTime) {
      lastTopic.endTime = Date.now();
      console.log(`📚 Topic ended in ${channelName}: ${lastTopic.topicName}`);
    }
  }
  
  res.json({ success: true });
});

/**
 * Get topics for a channel
 */
app.get('/api/topics/:channelName', (req, res) => {
  const { channelName } = req.params;
  const topics = topicTracking.get(channelName) || [];
  res.json({ topics });
});

/**
 * Generate PDF report data with per-student engagement percentages
 */
app.get('/api/report/:channelName', (req, res) => {
  const { channelName } = req.params;
  const analytics = analyticsData.get(channelName) || [];
  const topics = topicTracking.get(channelName) || [];
  
  // Get unique students
  const uniqueStudents = [...new Set(analytics.map(a => a.studentId))];
  const studentNames = {};
  analytics.forEach(a => {
    if (!studentNames[a.studentId]) {
      studentNames[a.studentId] = a.studentName;
    }
  });
  
  // Calculate engagement statistics per topic
  const topicStats = topics.map(topic => {
    const topicAnalytics = analytics.filter(a => 
      a.timestamp >= topic.startTime && 
      (!topic.endTime || a.timestamp <= topic.endTime)
    );
    
    // Overall engagement counts
    const engagementCounts = {
      'Engaged': 0,
      'Bored': 0,
      'Confused': 0,
      'Not Paying Attention': 0
    };
    
    topicAnalytics.forEach(a => {
      if (engagementCounts.hasOwnProperty(a.engagement)) {
        engagementCounts[a.engagement]++;
      }
    });
    
    // Per-student engagement percentages
    const studentStats = uniqueStudents.map(studentId => {
      const studentData = topicAnalytics.filter(a => a.studentId === studentId);
      
      const studentEngagementCounts = {
        'Engaged': 0,
        'Bored': 0,
        'Confused': 0,
        'Not Paying Attention': 0
      };
      
      studentData.forEach(a => {
        if (studentEngagementCounts.hasOwnProperty(a.engagement)) {
          studentEngagementCounts[a.engagement]++;
        }
      });
      
      const totalDataPoints = studentData.length;
      const engagementPercentage = totalDataPoints > 0 
        ? (studentEngagementCounts['Engaged'] / totalDataPoints) * 100 
        : 0;
      
      return {
        studentId,
        studentName: studentNames[studentId] || `Student ${studentId}`,
        totalDataPoints,
        engagementCounts: studentEngagementCounts,
        engagementPercentage: Math.round(engagementPercentage * 10) / 10, // Round to 1 decimal
        boredPercentage: totalDataPoints > 0 ? Math.round((studentEngagementCounts['Bored'] / totalDataPoints) * 1000) / 10 : 0,
        confusedPercentage: totalDataPoints > 0 ? Math.round((studentEngagementCounts['Confused'] / totalDataPoints) * 1000) / 10 : 0,
        notPayingAttentionPercentage: totalDataPoints > 0 ? Math.round((studentEngagementCounts['Not Paying Attention'] / totalDataPoints) * 1000) / 10 : 0
      };
    });
    
    // Calculate class average engagement percentage
    const classAverageEngagement = studentStats.length > 0
      ? studentStats.reduce((sum, s) => sum + s.engagementPercentage, 0) / studentStats.length
      : 0;
    
    return {
      topicName: topic.topicName,
      startTime: topic.startTime,
      endTime: topic.endTime,
      duration: topic.endTime ? (topic.endTime - topic.startTime) : null,
      engagementCounts,
      totalDataPoints: topicAnalytics.length,
      studentStats,
      classAverageEngagement: Math.round(classAverageEngagement * 10) / 10
    };
  });
  
  // Overall class statistics
  const overallStats = uniqueStudents.map(studentId => {
    const studentData = analytics.filter(a => a.studentId === studentId);
    
    const studentEngagementCounts = {
      'Engaged': 0,
      'Bored': 0,
      'Confused': 0,
      'Not Paying Attention': 0
    };
    
    studentData.forEach(a => {
      if (studentEngagementCounts.hasOwnProperty(a.engagement)) {
        studentEngagementCounts[a.engagement]++;
      }
    });
    
    const totalDataPoints = studentData.length;
    const engagementPercentage = totalDataPoints > 0 
      ? (studentEngagementCounts['Engaged'] / totalDataPoints) * 100 
      : 0;
    
    return {
      studentId,
      studentName: studentNames[studentId] || `Student ${studentId}`,
      totalDataPoints,
      engagementPercentage: Math.round(engagementPercentage * 10) / 10
    };
  });
  
  const overallClassAverage = overallStats.length > 0
    ? overallStats.reduce((sum, s) => sum + s.engagementPercentage, 0) / overallStats.length
    : 0;
  
  res.json({ 
    channelName,
    topics: topicStats,
    overallStats,
    overallClassAverage: Math.round(overallClassAverage * 10) / 10,
    analytics,
    generatedAt: Date.now()
  });
});

// =====================================
// WEBSOCKET CONNECTIONS
// =====================================

io.on('connection', (socket) => {
  console.log(`🔌 New connection: ${socket.id}`);

  // DEBUG: Log ALL events received on this socket
  socket.onAny((eventName, ...args) => {
    console.log(`📥 Event received: ${eventName}`, args.length > 0 ? `(${args.length} args)` : '');
  });

  /**
   * Student joins a channel
   */
  socket.on('student:join', (data) => {
    const { studentId, channelName, studentName } = data;
    
    const displayName = studentName || `Student ${studentId}`;
    
    activeSessions.students.set(studentId, {
      id: studentId,
      name: displayName,
      socketId: socket.id,
      channelName,
      emotion: null,
      confidence: null,
      timestamp: Date.now()
    });

    socket.join(`channel:${channelName}`);
    socket.join('students');

    console.log(`👨‍🎓 ${displayName} (ID: ${studentId}) joined channel: ${channelName}`);

    // Notify ALL users in the channel (students + teachers)
    io.to(`channel:${channelName}`).emit('student:joined', {
      studentId,
      studentName: displayName,
      timestamp: Date.now()
    });
    
    // Send existing students list to the new student
    const existingStudents = Array.from(activeSessions.students.values())
      .filter(s => s.channelName === channelName && s.id !== studentId);
    
    existingStudents.forEach(existingStudent => {
      socket.emit('student:joined', {
        studentId: existingStudent.id,
        studentName: existingStudent.name,
        timestamp: Date.now()
      });
    });
    
    // Send existing teachers list to the new student
    const existingTeachers = Array.from(activeSessions.teachers.values())
      .filter(t => t.channelName === channelName);
    
    existingTeachers.forEach(teacher => {
      socket.emit('teacher:joined', {
        teacherId: teacher.id,
        teacherName: teacher.name,
        timestamp: Date.now()
      });
    });
  });

  /**
   * Teacher joins a channel
   */
  socket.on('teacher:join', (data) => {
    const { teacherId, channelName, teacherName } = data;
    
    const displayName = teacherName || `Teacher ${teacherId}`;
    
    activeSessions.teachers.set(teacherId, {
      id: teacherId,
      name: displayName,
      socketId: socket.id,
      channelName
    });

    socket.join(`channel:${channelName}`);
    socket.join(`teachers:${channelName}`);

    console.log(`👨‍🏫 ${displayName} (ID: ${teacherId}) joined channel: ${channelName}`);

    // Notify ALL users in channel that teacher joined
    io.to(`channel:${channelName}`).emit('teacher:joined', {
      teacherId,
      teacherName: displayName,
      timestamp: Date.now()
    });

    // Send current students list to teacher
    const studentsInChannel = Array.from(activeSessions.students.values())
      .filter(student => student.channelName === channelName);

    console.log(`📋 Sending ${studentsInChannel.length} students to teacher:`, studentsInChannel.map(s => `${s.name} (${s.id})`).join(', '));
    socket.emit('students:list', { students: studentsInChannel });
    
    // Also broadcast to all students in channel that teacher joined (so they can update names)
    studentsInChannel.forEach(student => {
      io.to(student.socketId).emit('teacher:joined', {
        teacherId,
        teacherName: displayName,
        timestamp: Date.now()
      });
    });
  });

  /**
   * Receive video frame from student for emotion detection
   */
  socket.on('frame:send', async (data) => {
    try {
      const { studentId, frame, channelName, timestamp } = data;

      // Get student name from session
      const student = activeSessions.students.get(studentId);
      const studentName = student ? student.name : `Student ${studentId}`;

      console.log(`📸 Received frame from ${studentName} (ID: ${studentId}), frame size: ${Math.round(frame.length / 1024)} KB`);

      // Forward frame to Python ML service
      console.log(`🔄 Forwarding frame to ML service at ${CONFIG.ML_SERVICE_URL}/predict...`);
      
      const mlResponse = await axios.post(
        `${CONFIG.ML_SERVICE_URL}/predict`,
        { image: frame },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000 // Increased timeout to 10 seconds
        }
      );

      console.log(`✅ ML service responded successfully`);

      const { emotion, confidence } = mlResponse.data;
      const engagement = mapEmotionToEngagement(emotion);

      console.log(`🎭 Detected emotion for ${studentName}: ${emotion} → ${engagement} (${(confidence * 100).toFixed(1)}%)`);

      // Update student's emotion in active sessions
      if (activeSessions.students.has(studentId)) {
        const existingStudent = activeSessions.students.get(studentId);
        existingStudent.emotion = emotion;
        existingStudent.engagement = engagement;
        existingStudent.confidence = confidence;
        existingStudent.timestamp = Date.now();
      }
      
      // Store analytics data
      if (!analyticsData.has(channelName)) {
        analyticsData.set(channelName, []);
      }
      analyticsData.get(channelName).push({
        timestamp: Date.now(),
        studentId,
        studentName,
        emotion,
        engagement,
        confidence
      });

      // Send engagement state back to student
      socket.emit('emotion:result', {
        emotion,
        engagement,
        confidence,
        timestamp: Date.now()
      });
      console.log(`📤 Sent engagement result to ${studentName}`);

      // Broadcast engagement update to teachers in the same channel
      io.to(`teachers:${channelName}`).emit('emotion:update', {
        studentId,
        studentName,
        emotion,
        engagement,
        confidence,
        timestamp: Date.now()
      });
      console.log(`📡 Broadcast emotion update to teachers in channel: ${channelName}`);

    } catch (error) {
      console.error('❌ Error processing frame:', error.message);
      if (error.code === 'ECONNREFUSED') {
        console.error('❌ ML service is not reachable at', CONFIG.ML_SERVICE_URL);
      }
      if (error.response) {
        console.error('❌ ML service error response:', error.response.status, error.response.data);
      }
      
      socket.emit('emotion:error', {
        error: 'Failed to process frame',
        details: error.message
      });
    }
  });

  /**
   * Student leaves channel
   */
  socket.on('student:leave', (data) => {
    const { studentId, channelName } = data;
    
    // Get student name before deleting
    const student = activeSessions.students.get(studentId);
    const studentName = student ? student.name : `Student ${studentId}`;
    
    activeSessions.students.delete(studentId);
    socket.leave(`channel:${channelName}`);
    
    console.log(`👨‍🎓 ${studentName} (ID: ${studentId}) left channel: ${channelName}`);

    // Notify teachers
    io.to(`teachers:${channelName}`).emit('student:left', {
      studentId,
      timestamp: Date.now()
    });
  });

  /**
   * Teacher leaves channel
   */
  socket.on('teacher:leave', (data) => {
    const { teacherId, channelName } = data;
    
    // Get teacher name before deleting
    const teacher = activeSessions.teachers.get(teacherId);
    const teacherName = teacher ? teacher.name : `Teacher ${teacherId}`;
    
    activeSessions.teachers.delete(teacherId);
    socket.leave(`channel:${channelName}`);
    socket.leave(`teachers:${channelName}`);
    
    console.log(`👨‍🏫 ${teacherName} (ID: ${teacherId}) left channel: ${channelName}`);
  });

  /**
   * Handle disconnection
   */
  socket.on('disconnect', () => {
    console.log(`🔌 Disconnected: ${socket.id}`);
    
    // Clean up from active sessions
    for (const [studentId, student] of activeSessions.students.entries()) {
      if (student.socketId === socket.id) {
        activeSessions.students.delete(studentId);
        io.to(`teachers:${student.channelName}`).emit('student:left', {
          studentId,
          timestamp: Date.now()
        });
      }
    }

    for (const [teacherId, teacher] of activeSessions.teachers.entries()) {
      if (teacher.socketId === socket.id) {
        activeSessions.teachers.delete(teacherId);
      }
    }
  });
});

// =====================================
// HEALTH CHECK ENDPOINT
// =====================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    connections: {
      students: activeSessions.students.size,
      teachers: activeSessions.teachers.size
    }
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Student Engagement Portal API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      token: '/api/token',
      analytics: '/api/analytics/:channelName',
      topics: '/api/topics/:channelName',
      report: '/api/report/:channelName'
    }
  });
});

// =====================================
// START SERVER
// =====================================

const HOST = process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';

server.listen(CONFIG.PORT, HOST, () => {
  console.log('');
  console.log('🚀 ========================================');
  console.log('🚀 Student Engagement Portal - Backend');
  console.log('🚀 ========================================');
  console.log(`🌐 HTTP Server: http://${HOST}:${CONFIG.PORT}`);
  console.log(`🔌 WebSocket Server: ws://${HOST}:${CONFIG.PORT}`);
  console.log(`🤖 ML Service: ${CONFIG.ML_SERVICE_URL}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('🚀 ========================================');
  console.log('');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n⏹️  Shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
