import mongoose from "mongoose";

const ParticipantSchema = new mongoose.Schema({
  competitionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Competition',
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  username: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['waiting', 'playing', 'submitted', 'completed'],
    default: 'waiting'
  },
  score: {
    type: Number,
    default: 0
  },
  puzzlesSolved: {
    type: Number,
    default: 0
  },
  timeSpent: {
    type: Number,
    default: 0
  }, // in seconds
  joinedAt: {
    type: Date,
    default: Date.now
  },
  submittedAt: {
    type: Date
  }, // When user submitted early (optional)
  lastActivity: {
    type: Date,
    default: Date.now
  },
  isActive: {
    type: Boolean,
    default: true
  }
});

// Compound index for unique participation per competition
ParticipantSchema.index({ competitionId: 1, userId: 1 }, { unique: true });

// Index for leaderboard queries
ParticipantSchema.index({ competitionId: 1, score: -1, timeSpent: 1 });

const ParticipantModel = mongoose.model("Participant", ParticipantSchema);

export default ParticipantModel;