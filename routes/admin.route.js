import express from "express";
import { loginAdmin } from "../controllers/admin.controller.js";
import { getAllUsers, deleteUserById } from "../controllers/user.controller.js";
import isAdmin from "../middleware/admin.middleware.js";
import { adminLoginRateLimiter } from "../middleware/rateLimit.middleware.js";

const router = express.Router();

// Admin login
router.post("/login", adminLoginRateLimiter, loginAdmin);

// Admin user management routes (protected)
router.get("/users", isAdmin, getAllUsers);
router.delete("/users/:id", isAdmin, deleteUserById);

export default router;
