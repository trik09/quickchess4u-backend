import express from "express";
import {
  createPuzzle,
  getPuzzles,
  getPuzzleById,
  updatePuzzle,
  deletePuzzle,
  deleteAllPuzzles,
  getPuzzlesWithFilters,
  getPuzzleStats,
  getRandomPuzzle,
  bulkCreatePuzzles,
  exportPuzzles,
  deleteMultiplePuzzles,
  validatePuzzles,
  deleteInvalidPuzzles,
  toggleDailyTraining
} from "../controllers/puzzle.controller.js";
import isAdmin from "../middleware/admin.middleware.js";

const router = express.Router();

// Manual puzzle routes
router.post("/create-puzzle", isAdmin, createPuzzle);
router.post("/bulk-create-puzzle", isAdmin, bulkCreatePuzzles);
router.get("/export-puzzles", isAdmin, exportPuzzles);
router.get("/get-puzzles", getPuzzles);
router.get("/get-puzzle/:id", getPuzzleById);
router.put("/update-puzzle/:id", isAdmin, updatePuzzle);
router.delete("/delete-all-puzzles", isAdmin, deleteAllPuzzles);
router.post("/delete-multiple-puzzles", isAdmin, deleteMultiplePuzzles);
router.delete("/delete-puzzle/:id", isAdmin, deletePuzzle);
router.patch("/toggle-daily/:id", isAdmin, toggleDailyTraining);

// Validation routes
router.get("/validate-puzzles", isAdmin, validatePuzzles);
router.post("/delete-invalid-puzzles", isAdmin, deleteInvalidPuzzles);

// Lichess import routes
// Lichess import routes
// router.post("/import-lichess", isAdmin, importFromLichess); // Removed

router.get("/puzzles-filtered", getPuzzlesWithFilters);
router.get("/puzzle-stats", getPuzzleStats);

// Casual puzzle route (no auth required)
router.get("/random-puzzle", getRandomPuzzle);

export default router;