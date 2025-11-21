/**
 * Authentication Routes
 * Handles user signup and login
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');

// JWT secret (should be in .env)
const JWT_SECRET = process.env.JWT_SECRET || '16a3f75c426cb5a40d723f7ccef76aa70c1dbfd65951aa9e2b0ce0e5f9edc421e866f6fcd1f22ee0399183466cdea71320c60775bb377531cc7e84862e7678e2
';

/**
 * POST /api/auth/signup
 * Register a new user (student or teacher)
 */
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password, role, rollNumber, course, employeeId, department } = req.body;

    // Validate required fields
    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: 'Please provide all required fields' });
    }

    // Validate role-specific fields
    if (role === 'student' && (!rollNumber || !course)) {
      return res.status(400).json({ message: 'Roll number and course are required for students' });
    }

    if (role === 'teacher' && (!employeeId || !department)) {
      return res.status(400).json({ message: 'Employee ID and department are required for teachers' });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }

    // Create new user
    const userData = {
      name,
      email,
      password,
      role
    };

    if (role === 'student') {
      userData.rollNumber = rollNumber;
      userData.course = course;
    } else {
      userData.employeeId = employeeId;
      userData.department = department;
    }

    const user = new User(userData);
    await user.save();

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`✅ New ${role} registered: ${name} (${email})`);

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: user.toJSON()
    });
  } catch (error) {
    console.error('❌ Signup error:', error);
    res.status(500).json({ message: 'Registration failed', error: error.message });
  }
});

/**
 * POST /api/auth/login
 * Login existing user
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password, role } = req.body;

    // Validate required fields
    if (!email || !password || !role) {
      return res.status(400).json({ message: 'Please provide email, password, and role' });
    }

    // Find user by email and role
    const user = await User.findOne({ email, role });
    if (!user) {
      return res.status(401).json({ message: 'Invalid email, password, or role' });
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid email, password, or role' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`✅ User logged in: ${user.name} (${user.email}) as ${role}`);

    res.json({
      message: 'Login successful',
      token,
      user: user.toJSON()
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ message: 'Login failed', error: error.message });
  }
});

/**
 * GET /api/auth/verify
 * Verify JWT token and get user data
 */
router.get('/verify', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ message: 'No token provided' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId);

    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    res.json({
      valid: true,
      user: user.toJSON()
    });
  } catch (error) {
    res.status(401).json({ message: 'Invalid token', valid: false });
  }
});

module.exports = router;
