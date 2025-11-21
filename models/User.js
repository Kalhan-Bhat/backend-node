/**
 * User Model for Authentication
 * Supports both Student and Teacher roles
 */

const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema({
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
  role: {
    type: String,
    enum: ['student', 'teacher'],
    required: true
  },
  // Student-specific fields
  rollNumber: {
    type: String,
    required: function() { return this.role === 'student'; }
  },
  course: {
    type: String,
    required: function() { return this.role === 'student'; }
  },
  // Teacher-specific fields
  employeeId: {
    type: String,
    required: function() { return this.role === 'teacher'; }
  },
  department: {
    type: String,
    required: function() { return this.role === 'teacher'; }
  }
}, {
  timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare passwords
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Remove password from JSON response
userSchema.methods.toJSON = function() {
  const user = this.toObject();
  delete user.password;
  return user;
};

module.exports = mongoose.model('User', userSchema);
