import express from "express";
import {
  createExam,
  getAdminExams,
  getExamById,
  updateExam,
  deleteExam,
  getPublicExams,
  getExamDetailsForUser,
  submitExam,
  getExamResults,
  joinExam
} from "../controllers/exam.controller.js";
import isAdmin from "../middleware/admin.middleware.js";
import { isAuthenticated } from "../middleware/auth.middleware.js";

const router = express.Router();

// Admin Routes
router.post("/create-exam", isAdmin, createExam);
router.get("/admin/get-exams", isAdmin, getAdminExams);
router.get("/admin/get-exam/:id", isAdmin, getExamById);
router.put("/update-exam/:id", isAdmin, updateExam);
router.delete("/delete-exam/:id", isAdmin, deleteExam);

// User Routes
router.get("/public/get-exams", getPublicExams);
router.get("/public/get-exam/:id", isAuthenticated, getExamDetailsForUser);
router.post("/public/join-exam/:id", isAuthenticated, joinExam);
router.post("/public/submit-exam/:id", isAuthenticated, submitExam);
router.get("/public/exam-results/:id", isAuthenticated, getExamResults);

export default router;
