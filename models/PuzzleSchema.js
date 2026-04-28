import mongoose from "mongoose";

const PuzzleSchema = new mongoose.Schema({
  title: String,
  fen: { type: String, required: true },
  difficulty: { type: String, enum: ["easy", "medium", "hard"] },
  solutionMoves: [String],
  alternativeSolutions: [[String]],
  // ["e4", "Nf6", ...]
  description: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },

  // Puzzle type
  type: {
    type: String,
    enum: ["normal", "capture", "illegal"],
    default: "normal"
  },

  // Difficulty & Rating
  level: { type: Number, required: true, default: 1 }, // 1 to 7
  rating: { type: Number, required: true, default: 400 },

  // Capture mode configuration (formerly Kids)
  captureConfig: {
    mode: { type: String, enum: ["objects", "pieces"], default: "objects" },
    piece: String, // Player piece: e.g., "n" for knight, "r" for rook
    playerSide: { type: String, enum: ["w", "b"], default: "w" },
    startSquare: String, // e.g., "e4" (Legacy)
    playerPieces: [{
      square: String,
      type: { type: String }, // e.g., "n", "r"
      color: { type: String, enum: ["w", "b"] }
    }],
    targets: [{
      square: String,
      item: { type: String, enum: ["pizza", "chocolate", "star", "burger", "p", "n", "b", "r", "q", "k"] }
    }],
    enemyPieces: [{
      square: String,
      type: { type: String } // e.g., "p", "n", "r"
    }]
  },

  // Illegal move configuration
  illegalConfig: {
    subType: { type: String, enum: ["normal", "source_destination"], default: "normal" },
    sourceSquare: String,      // e.g., "a5", the specific piece the user must move
    destinationSquare: String, // e.g., "e6", the ultimate destination for the piece
    playerSide: { type: String, enum: ["w", "b"], default: "w" },
  },

  // Source tracking
  source: {
    type: String,
    enum: ["manual"],
    default: "manual"
  },

  // Category
  category: {
    type: String,
    required: true,
    default: "Tactics"
  },

  // Who plays the first solution move: 'human' (default) or 'computer'
  firstMoveBy: { type: String, enum: ["human", "computer", "w", "b"], default: "human" },

  // Tracks whether this puzzle has been through chess.js validation scan
  // false = not yet validated (newly imported), true = already scanned
  isValidated: { type: Boolean, default: false },

  isDailyTraining: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now }
});

// Index for faster queries
PuzzleSchema.index({ type: 1, category: 1 });
PuzzleSchema.index({ isValidated: 1 });
PuzzleSchema.index({ isDailyTraining: 1 });

const PuzzleModel = mongoose.model("Puzzle", PuzzleSchema);

export default PuzzleModel;
