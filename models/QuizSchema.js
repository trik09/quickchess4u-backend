import mongoose from "mongoose";

const QuizSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ["mcq", "column_matching"],
    required: true
  },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "QuizCategory",
    required: true
  },
  questionText: {
    type: String,
    required: true
  },
  // MCQ Specific Fields
  isBoardBased: {
    type: Boolean,
    default: false
  },
  fen: {
    type: String
  },
  options: [{
    text: String,
    isCorrect: Boolean
  }],
  // Column Matching Specific Fields
  pairs: [{
    leftItem: String,
    rightItem: String,
    correctAnswer: String
  }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Admin"
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

QuizSchema.pre('save', function () {
  this.updatedAt = Date.now();
});

const QuizModel = mongoose.model("Quiz", QuizSchema);

export default QuizModel;
