/**
 * User Models for Authentication
 * Separate Student and Teacher models for existing collections
 */

const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

// Student Schema
const studentSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true
  },
  rollNumber: {
    type: String,
    required: true
  },
  course: {
    type: String,
    required: true
  },
  role: {
    type: String,
    default: 'student'
  }
}, {
  timestamps: true
});

// Teacher Schema
const teacherSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true
  },
  employeeId: {
    type: String,
    required: true
  },
  department: {
    type: String,
    required: true
  },
  role: {
    type: String,
    default: 'teacher'
  }
}, {
  timestamps: true
});

// Hash password before saving - Student
studentSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Hash password before saving - Teacher
teacherSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare passwords - Student
studentSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Method to compare passwords - Teacher
teacherSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Remove password from JSON response - Student
studentSchema.methods.toJSON = function() {
  const user = this.toObject();
  delete user.password;
  return user;
};

// Remove password from JSON response - Teacher
teacherSchema.methods.toJSON = function() {
  const user = this.toObject();
  delete user.password;
  return user;
};

const Student = mongoose.model('Student', studentSchema, 'students');
const Teacher = mongoose.model('Teacher', teacherSchema, 'teachers');

module.exports = { Student, Teacher };
