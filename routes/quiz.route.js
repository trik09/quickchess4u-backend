import express from "express";
import {
  createQuiz,
  getQuizzes,
  getQuizById,
  updateQuiz,
  deleteQuiz
} from "../controllers/quiz.controller.js";
import isAdmin from "../middleware/admin.middleware.js";

const router = express.Router();

router.post("/create-quiz", isAdmin, createQuiz);
router.get("/get-quizzes", getQuizzes);
router.get("/get-quiz/:id", getQuizById);
router.put("/update-quiz/:id", isAdmin, updateQuiz);
router.delete("/delete-quiz/:id", isAdmin, deleteQuiz);

export default router;
