import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";
import userRoutes from "./routes/user.route.js";
import adminRoutes from "./routes/admin.route.js";
import connectDB from "./config/db.js"
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
connectDB();

const app = express();
const server = createServer(app);

// Required for correct client IP detection behind Nginx (rate limiting, logs, etc.)
// If you have multiple proxy hops, set this to the exact hop count instead of "1".
app.set("trust proxy", 1);

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST","PUT","PATCH","DELETE"],
  },
});

// Initialize socket handlers
initializeSocketHandlers(io);


// Middleware
const allowedOrigins = new Set(
  [
    process.env.FRONTEND_URL,
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://test.quickchessforyou.com"
  ].filter(Boolean)
);

app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser clients (curl/postman) where Origin is not set
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
  })
);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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
  return res.status(200).json({ message: "QuickChess4U backend is running" });
})


console.log("Chess import:", Chess);


// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Socket.IO server initialized`);
});

// Export io for use in other modules
export { io };