import User from "../models/UserSchema.js";
import OTP from "../models/OTPSchema.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import sendOTPEmail from "../utils/emailService.js";
import PuzzleModel from "../models/PuzzleSchema.js";
import PuzzleHistoryModel from "../models/PuzzleHistorySchema.js";
import CompetitionModel from "../models/CompetitionSchema.js";
import fs from "fs";
import path from "path";



const validatePassword = (password) => {
  const minLength = 8;
  const hasNumber = /\d/.test(password);
  const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);
  const hasLetter = /[a-zA-Z]/.test(password);

  if (password.length < minLength) return "Password must be at least 8 characters long";
  if (!hasNumber) return "Password must contain at least one number";
  if (!hasSpecialChar) return "Password must contain at least one special character";
  if (!hasLetter) return "Password must contain at least one letter";
  return null;
};

const register = async (req, res) => {
  try {
    const { name, email, password, username, wins, losses, draws } = req.body;
    if (!name || !email || !password || !username) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ message: passwordError });
    }
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    const avatar = req.file ? req.file.path : "";
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashedPassword, username, avatar, wins, losses, draws });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });
    const safeUser = { name: user.name, username: user.username, email: user.email, authProvider: user.authProvider };

    return res.status(200).json({ message: "User registered successfully", user:safeUser, token });



  } catch (error) {
    return res.status(500).json({ message: "Internal server error" });
  }
}




const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }
    // Allow 'email' to be either an email address or username
    const user = await User.findOne({
      $or: [{ email: email }, { username: email }]
    });
    if (!user) {
      return res.status(400).json({ message: "User not found" });
    }
    const isPasswordMatched = await bcrypt.compare(password, user.password);
    if (!isPasswordMatched) {
      return res.status(400).json({ message: "Invalid password" });
    }
    const token = jwt.sign(
      {
        id: user._id
      }, process.env.JWT_SECRET, { expiresIn: "7d" });
    const safeUser = { name: user.name, username: user.username, email: user.email, authProvider: user.authProvider };
    return res.status(200).json({ message: "User logged in successfully", user: safeUser, token });
  } catch (error) {
    return res.status(500).json({ message: "Internal server error" });
  }
}



// Generate random 6-digit OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Send OTP to user's email
const sendOTP = async (req, res) => {
  try {
    const { email } = req.body;

    console.log('📨 Send OTP request received for:', email);

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    // Check if user exists
    console.log('Checking if user exists...');
    const user = await User.findOne({ email });
    if (!user) {
      console.log(' User not found:', email);
      return res.status(404).json({ message: "User not found. Please register first." });
    }
    console.log('✅ User found:', user.email);

    // Delete any existing OTPs for this email
   // console.log('🗑️  Deleting existing OTPs...');
    await OTP.deleteMany({ email });

    // Generate new OTP
    const otp = generateOTP();
    console.log('Generated otp');

    // Save OTP to database
    console.log('💾 Saving OTP to database...');
    await OTP.create({
      email,
      otp,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000) // 10 minutes
    });
    console.log('✅ OTP saved to database');

    // Send OTP via email
    //  console.log('📧 Sending OTP email...');
    const emailSent = await sendOTPEmail(email, otp);

    if (!emailSent) {
      // console.log('❌ Email sending failed');
      return res.status(500).json({ message: "Failed to send OTP email" });
    }

    //console.log('✅ OTP process ENDED successfully');
    return res.status(200).json({
      message: "OTP sent successfully to your email",
      // In development, you might want to return OTP for testing
      ...(process.env.NODE_ENV === 'development' && { otp })
    });
  } catch (error) {
    console.error("❌ Send OTP error:", error.message);
    // console.error("📋 Error details:", {
    //   name: error.name,
    //   message: error.message,
    //   stack: error.stack
    // });
    return res.status(500).json({
      message: "Internal server error",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Send OTP for signup email verification
const sendSignupOTP = async (req, res) => {
  try {
    const { email, name, username, password } = req.body;

    console.log('📨 Send Signup OTP request received for:', email);

    // Validate required fields
    if (!email || !name || !username || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    // Check if user already exists
    console.log('🔍 Checking if user already exists...');
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      console.log('❌ User already exists:', email);
      return res.status(400).json({ message: "User with this email already exists" });
    }

    // Check if username is taken
    const existingUsername = await User.findOne({ username });
    if (existingUsername) {
      return res.status(400).json({ message: "Username already taken" });
    }

    // Delete any existing OTPs for this email
    console.log('🗑️  Deleting existing OTPs...');
    await OTP.deleteMany({ email });

    // Generate new OTP
    const otp = generateOTP();
    console.log('🔑 Generated OTP:', otp);

    // Save OTP to database with type 'signup'
    console.log('💾 Saving OTP to database...');
    await OTP.create({
      email,
      otp,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000) // 10 minutes
    });
    console.log('✅ OTP saved to database');

    // Send OTP via email
    const emailSent = await sendOTPEmail(email, otp);

    if (!emailSent) {
      return res.status(500).json({ message: "Failed to send OTP email" });
    }

    console.log('✅ Signup OTP sent successfully');
    return res.status(200).json({
      message: "OTP sent successfully to your email. Please verify to complete registration.",
      // In development, you might want to return OTP for testing
      ...(process.env.NODE_ENV === 'development' && { otp })
    });
  } catch (error) {
    console.error("❌ Send Signup OTP error:", error.message);
    return res.status(500).json({
      message: "Internal server error",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Verify signup OTP and create user account
const verifySignupOTP = async (req, res) => {
  try {
    const { email, otp, name, username, password } = req.body;

    console.log('🔐 Verify Signup OTP request for:', email);

    // Validate required fields
    if (!email || !otp || !name || !username || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ message: passwordError });
    }

    // Find the OTP record
    const otpRecord = await OTP.findOne({
      email,
      isUsed: false,
      expiresAt: { $gt: new Date() } // Not expired
    });

    if (!otpRecord) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    // Verify OTP
    if (otpRecord.otp !== otp) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    // Check again if user exists (in case created between sending OTP and verifying)
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    // Check if username is taken
    const existingUsername = await User.findOne({ username });
    if (existingUsername) {
      return res.status(400).json({ message: "Username already taken" });
    }

    // Mark OTP as used
    otpRecord.isUsed = true;
    await otpRecord.save();

    // Hash password and create user
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      username,
      avatar: ""
    });

    // Generate JWT token
    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    const safeUser = { name: user.name, username: user.username, email: user.email, authProvider: user.authProvider };
    console.log('✅ User registered successfully:', user.email);
    return res.status(200).json({
      message: "User registered successfully",
      user: safeUser,
      token
    });
  } catch (error) {
    console.error("❌ Verify Signup OTP error:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};


// Verify OTP and login user
const verifyOTP = async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: "Email and OTP are required" });
    }

    // Find the OTP record
    const otpRecord = await OTP.findOne({
      email,
      isUsed: false,
      expiresAt: { $gt: new Date() } // Not expired
    });

    if (!otpRecord) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    // Verify OTP
    if (otpRecord.otp !== otp) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    // Mark OTP as used
    otpRecord.isUsed = true;
    await otpRecord.save();

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    const safeUser = { name: user.name, username: user.username, email: user.email, authProvider: user.authProvider };
    return res.status(200).json({
      message: "OTP verified successfully. Logged in.",
      user: safeUser,
      token
    });
  } catch (error) {
    console.error("Verify OTP error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// Reset password
const resetPassword = async (req, res) => {
  try {
    const { password } = req.body;
    const userId = req.user._id;

    if (!password) {
      return res.status(400).json({ message: "Password is required" });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Update user password
    await User.findByIdAndUpdate(userId, {
      password: hashedPassword
    });

    return res.status(200).json({ message: "Password reset successfully" });
  } catch (error) {
    console.error("Reset password error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const getAllPuzzles = async (req, res) => {
  try {
    const puzzles = await PuzzleModel.find();
    return res.status(200).json({ puzzles });
  } catch (error) {
    return res.status(500).json({ message: "Internal server error" });
  }
};


// Get current user data with statistics
const getCurrentUser = async (req, res) => {
  try {
    const userId = req.user._id; // Get user ID from authenticated middleware

    // Find the user and exclude password
    const user = await User.findById(userId).select('-password');
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Get statistics
    // Count solved puzzles (where isSolved is true)
    const puzzlesSolved = await PuzzleHistoryModel.countDocuments({
      userId: userId,
      isSolved: true
    });

    // Count competitions participated in (where user is in participants array)
    const competitionsParticipated = await CompetitionModel.countDocuments({
      'participants.user': userId
    });

    // Convert user to object and add statistics
    const userObject = user.toObject();
    userObject.statistics = {
      puzzlesSolved,
      competitionsParticipated
    };

    return res.status(200).json({
      message: "User data retrieved successfully",
      user: userObject
    });
  } catch (error) {
    console.error("Get current user error:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const updateUser = async (req, res) => {
  try {
    const { name, username } = req.body;
    const userId = req.user._id; // Get user ID from authenticated middleware

    // Find the user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Check if username is being changed and if it already exists
    if (username && username !== user.username) {
      const existingUser = await User.findOne({ username });
      if (existingUser) {
        return res.status(400).json({ message: "Username already exists" });
      }
    }

    // Handle file upload (avatar)
    let avatarPath = user.avatar; // Keep existing avatar by default
    if (req.file) {
      // Delete old avatar file if it exists
      if (user.avatar) {
        // Construct path relative to project root (where multer saves files)
        const oldAvatarPath = path.join(process.cwd(), user.avatar);
        try {
          if (fs.existsSync(oldAvatarPath)) {
            fs.unlinkSync(oldAvatarPath);
          }
        } catch (err) {
          console.error("Error deleting old avatar:", err);
          // Continue even if deletion fails
        }
      }
      avatarPath = req.file.path; // Save new avatar path
    }

    // Prepare update data
    const updateData = {};
    if (name) updateData.name = name;
    if (username) updateData.username = username;
    if (req.file) updateData.avatar = avatarPath;

    // Update user
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      updateData,
      { new: true, runValidators: true }
    );

    return res.status(200).json({
      message: "User updated successfully",
      user: updatedUser
    });
  } catch (error) {
    console.error("Update user error:", error);

    // Handle validation errors
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        message: "Validation error",
        error: error.message
      });
    }

    // Handle duplicate key error (for unique fields)
    if (error.code === 11000) {
      return res.status(400).json({
        message: "Username already exists"
      });
    }

    return res.status(500).json({
      message: "Internal server error",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};
// Admin: Get all users with statistics
const getAllUsers = async (req, res) => {
  try {
    // Get all users excluding passwords
    const users = await User.find().select('-password').sort({ createdAt: -1 });

    // Get statistics for each user
    const usersWithStats = await Promise.all(
      users.map(async (user) => {
        const puzzlesSolved = await PuzzleHistoryModel.countDocuments({
          userId: user._id,
          isSolved: true
        });

        const competitionsParticipated = await CompetitionModel.countDocuments({
          'participants.user': user._id
        });

        return {
          ...user.toObject(),
          statistics: {
            puzzlesSolved,
            competitionsParticipated
          }
        };
      })
    );

    return res.status(200).json({
      message: "Users retrieved successfully",
      success: true,
      data: usersWithStats,
      count: usersWithStats.length
    });
  } catch (error) {
    console.error("Get all users error:", error);
    return res.status(500).json({
      message: "Internal server error",
      success: false,
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Admin: Delete a user by ID
const deleteUserById = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if user exists
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({
        message: "User not found",
        success: false
      });
    }

    // Delete user's avatar file if exists
    if (user.avatar) {
      const avatarPath = path.join(process.cwd(), user.avatar);
      try {
        if (fs.existsSync(avatarPath)) {
          fs.unlinkSync(avatarPath);
        }
      } catch (err) {
        console.error("Error deleting avatar:", err);
        // Continue even if deletion fails
      }
    }

    // Delete user from database
    await User.findByIdAndDelete(id);

    // Note: You might also want to delete user's puzzle history and competition participations
    // Uncomment if you want to clean up related data:
    // await PuzzleHistoryModel.deleteMany({ userId: id });
    // await CompetitionModel.updateMany(
    //   { 'participants.user': id },
    //   { $pull: { participants: { user: id } } }
    // );

    return res.status(200).json({
      message: "User deleted successfully",
      success: true,
      deletedUser: {
        id: user._id,
        name: user.name,
        email: user.email
      }
    });
  } catch (error) {
    console.error("Delete user error:", error);
    return res.status(500).json({
      message: "Internal server error",
      success: false,
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Google OAuth authentication
const googleAuth = async (req, res) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({ message: "Google credential is required" });
    }

    // Verify Google ID token using Google's token verification endpoint
    const response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`
    );

    if (!response.ok) {
      return res.status(401).json({ message: "Invalid Google token" });
    }

    const googleUser = await response.json();

    // Verify the token is for our app
    if (googleUser.aud !== process.env.GOOGLE_CLIENT_ID) {
      return res.status(401).json({ message: "Token not intended for this app" });
    }

    const { sub: googleId, email, name, picture } = googleUser;

    // Try to find existing user by Google ID or email
    let user = await User.findOne({
      $or: [{ googleId }, { email }]
    });

    if (user) {
      // If user exists but doesn't have googleId, link the account
      if (!user.googleId) {
        user.googleId = googleId;
        user.authProvider = 'google';
        if (!user.avatar && picture) {
          user.avatar = picture;
        }
        await user.save();
      }
    } else {
      // Create new user
      // Generate a unique username from email
      let baseUsername = email.split('@')[0];
      let username = baseUsername;
      let counter = 1;

      // Ensure unique username
      while (await User.findOne({ username })) {
        username = `${baseUsername}${counter}`;
        counter++;
      }

      user = await User.create({
        name: name || email.split('@')[0],
        email,
        username,
        googleId,
        authProvider: 'google',
        avatar: picture || ''
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    const safeUser = { name: user.name, username: user.username, email: user.email, authProvider: user.authProvider };
    return res.status(200).json({
      message: "Google authentication successful",
      user: safeUser,
      token
    });
  } catch (error) {
    console.error("Google auth error:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

export { register, login, sendOTP, verifyOTP, resetPassword, sendSignupOTP, verifySignupOTP, getAllPuzzles, getCurrentUser, updateUser, getAllUsers, deleteUserById, googleAuth }

