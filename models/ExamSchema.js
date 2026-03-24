import mongoose from "mongoose";

const ExamSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: String,

  // Exam timing
  startTime: { type: Date, required: true },
  endTime: { type: Date, required: true },
  duration: { type: Number }, // Duration in minutes

  // Chapters — organizes quizzes into named groups
  chapters: [{
    name: { type: String, required: true },
    quizIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Quiz" }] 
  }],

  // Access constraints
  isActive: { type: Boolean, default: false },
  status: {
    type: String,
    enum: ["UPCOMING", "LIVE", "ENDED"],
    default: "UPCOMING"
  },

  // Participants & their submissions
  participants: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    score: {
      type: Number,
      default: 0
    },
    // Detailed answers
    answers: [{
      quizId: { type: mongoose.Schema.Types.ObjectId, ref: "Quiz" },
      // For MCQ: store the selected option ID or text
      selectedOption: String, 
      // For Column Matching: store array of matched pairs
      matchedPairs: [{
        leftItem: String,
        rightItem: String
      }],
      isCorrect: Boolean
    }],
    joinedAt: {
      type: Date,
      default: Date.now
    },
    submittedAt: {
      type: Date
    }
  }],

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

ExamSchema.index({ status: 1, startTime: 1 });
ExamSchema.index({ isActive: 1 });

const ExamModel = mongoose.model("Exam", ExamSchema);

export default ExamModel;
