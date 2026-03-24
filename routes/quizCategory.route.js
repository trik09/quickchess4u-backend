import express from "express";
import {
  createQuizCategory,
  getQuizCategories,
  getQuizCategoryById,
  updateQuizCategory,
  deleteQuizCategory
} from "../controllers/quizCategory.controller.js";
import isAdmin from "../middleware/admin.middleware.js";

const router = express.Router();

router.post("/create-category", isAdmin, createQuizCategory);
router.get("/get-categories", getQuizCategories);
router.get("/get-category/:id", getQuizCategoryById);
router.put("/update-category/:id", isAdmin, updateQuizCategory);
router.delete("/delete-category/:id", isAdmin, deleteQuizCategory);

export default router;
