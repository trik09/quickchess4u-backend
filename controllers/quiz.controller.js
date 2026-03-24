import QuizModel from "../models/QuizSchema.js";
import ExamModel from "../models/ExamSchema.js";

// Create a new quiz
export const createQuiz = async (req, res) => {
  try {
    const { type, category, questionText, isBoardBased, fen, options, pairs } = req.body;

    if (!type || !category || !questionText) {
      return res.status(400).json({ message: "Type, category, and questionText are required" });
    }

    if (type === "mcq") {
      if (!options || options.length < 2) {
        return res.status(400).json({ message: "MCQ must have at least 2 options" });
      }
      const hasCorrect = options.some(opt => opt.isCorrect);
      if (!hasCorrect) {
        return res.status(400).json({ message: "MCQ must have at least one correct option" });
      }
    } else if (type === "column_matching") {
      if (!pairs || pairs.length < 2) {
        return res.status(400).json({ message: "Column matching must have at least 2 pairs" });
      }
    } else {
      return res.status(400).json({ message: "Invalid quiz type" });
    }

    const quiz = await QuizModel.create({
      type,
      category,
      questionText,
      isBoardBased: isBoardBased || false,
      fen,
      options,
      pairs,
      createdBy: req.admin._id,
    });

    return res.status(201).json({
      message: "Quiz created successfully",
      quiz,
    });
  } catch (error) {
    console.error("Error creating quiz:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

// Get all quizzes
export const getQuizzes = async (req, res) => {
  try {
    const { category, type } = req.query;
    let query = {};

    if (category) query.category = category;
    if (type) query.type = type;

    const quizzes = await QuizModel.find(query)
      .populate("category", "name")
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json(quizzes);
  } catch (error) {
    console.error("Error fetching quizzes:", error);
    res.status(500).json({ message: "Failed to fetch quizzes", error: error.message });
  }
};

// Get a single quiz by ID
export const getQuizById = async (req, res) => {
  try {
    const { id } = req.params;
    const quiz = await QuizModel.findById(id).populate("category", "name");

    if (!quiz) {
      return res.status(404).json({ message: "Quiz not found" });
    }

    res.status(200).json(quiz);
  } catch (error) {
    console.error("Error fetching quiz:", error);
    res.status(500).json({ message: "Failed to fetch quiz", error: error.message });
  }
};

// Update a quiz
export const updateQuiz = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const quiz = await QuizModel.findById(id);
    if (!quiz) {
      return res.status(404).json({ message: "Quiz not found" });
    }

    if (updateData.type === "mcq") {
      if (updateData.options && updateData.options.length < 2) {
        return res.status(400).json({ message: "MCQ must have at least 2 options" });
      }
      if (updateData.options && !updateData.options.some(opt => opt.isCorrect)) {
        return res.status(400).json({ message: "MCQ must have at least one correct option" });
      }
    } else if (updateData.type === "column_matching") {
      if (updateData.pairs && updateData.pairs.length < 2) {
        return res.status(400).json({ message: "Column matching must have at least 2 pairs" });
      }
    }

    Object.assign(quiz, updateData);
    await quiz.save();

    res.status(200).json({
      message: "Quiz updated successfully",
      quiz,
    });
  } catch (error) {
    console.error("Error updating quiz:", error);
    res.status(500).json({ message: "Failed to update quiz", error: error.message });
  }
};

// Delete a quiz
export const deleteQuiz = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if quiz is used in any exams
    const examsUsingQuiz = await ExamModel.findOne({ "chapters.quizIds": id });
    if (examsUsingQuiz) {
      return res.status(400).json({
        message: "Cannot delete quiz because it is used in one or more exams.",
      });
    }

    const quiz = await QuizModel.findByIdAndDelete(id);
    if (!quiz) {
      return res.status(404).json({ message: "Quiz not found" });
    }

    res.status(200).json({ message: "Quiz deleted successfully" });
  } catch (error) {
    console.error("Error deleting quiz:", error);
    res.status(500).json({ message: "Failed to delete quiz", error: error.message });
  }
};
