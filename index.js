import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";
//import { createAdapter } from "@socket.io/redis-adapter";
import userRoutes from "./routes/user.route.js";
import adminRoutes from "./routes/admin.route.js";
import connectDB from "./config/db.js"
//import redisManager from "./config/redis.js";
import puzzleRoutes from "./routes/puzzle.route.js";
import competitionRoutes from "./routes/competition.route.js";
import liveCompetitionRoutes from "./routes/liveCompetition.route.js";
import categoryRoutes from "./routes/category.route.js";
import { Chess } from "chess.js";
import { initializeSocketHandlers } from "./utils/socketHandlers.js";

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Config
dotenv.config();
await connectDB();

const app = express();
const server = createServer(app);

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

// Initialize socket handlers
initializeSocketHandlers(io);

// Initialize Competition Manager for auto-start/end
import { initializeCompetitionManager } from "./utils/CompetitionManager.js";
initializeCompetitionManager(io);


// Middleware
app.use(cors());
app.use(express.json());

// Attach IO to request for controllers
app.use((req, res, next) => {
  req.io = io;
  next();
});

// Serve static files from uploads directory
app.use("/uploads", express.static(path.join(__dirname, "uploads")));


// Routes
app.use("/api/user", userRoutes)
app.use("/api/admin", adminRoutes)
app.use("/api/puzzle", puzzleRoutes)
app.use("/api/competition", competitionRoutes)
app.use("/api/live-competition", liveCompetitionRoutes)
app.use("/api/category", categoryRoutes)

app.get("/", (req, res) => {
  console.log("welcome to game ");
})


console.log("Chess import:", Chess);


// Start server
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Socket.IO server initialized`);
});

// Export io for use in other modules
export { io };