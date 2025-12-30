import CompetitionModel from "../models/CompetitionSchema.js";
import PuzzleModel from "../models/PuzzleSchema.js";
import ParticipantModel from "../models/ParticipantSchema.js";
import mongoose from "mongoose";

// Create a new competition
export const createCompetition = async (req, res) => {
  try {
    const { name, description, startTime, duration, puzzles, maxParticipants, accessCode } =
      req.body;
    console.log(req.body);

    // Validate required fields
    if (!name || !startTime || !duration) {
      return res.status(400).json({
        message: "Name, start time, and duration are required",
      });
    }

    // Calculate endTime based on startTime + duration (in minutes)
    const start = new Date(startTime);
    const durationInMinutes = parseInt(duration);
    const end = new Date(start.getTime() + durationInMinutes * 60 * 1000);

    // Validate puzzles exist
    if (puzzles && puzzles.length > 0) {
      const existingPuzzles = await PuzzleModel.find({ _id: { $in: puzzles } });
      if (existingPuzzles.length !== puzzles.length) {
        return res.status(400).json({
          message: "Some puzzles do not exist",
        });
      }
    }

    // Determine status based on start time
    const now = new Date();

    let status = "upcoming";
    let isActive = false;

    if (now >= start && now <= end) {
      status = "live";
      isActive = true;
    } else if (now > end) {
      status = "completed";
      isActive = false;
    }

    const competition = await CompetitionModel.create({
      name,
      description,
      startTime,
      endTime: end,
      duration: durationInMinutes,
      puzzles: puzzles || [],
      maxParticipants,
      status,
      isActive,
      accessCode,
      createdBy: req.admin._id,
    });

    res.status(201).json({
      message: "Competition created successfully",
      competition,
    });
  } catch (error) {
    console.error("Error creating competition:", error);
    res.status(500).json({
      message: "Failed to create competition",
      error: error.message,
    });
  }
};

// Get all competitions
export const getCompetitions = async (req, res) => {
  try {
    const { status, isActive, page = 1, limit = 10 } = req.query;

    const query = {};
    if (status) query.status = status;
    if (isActive !== undefined) query.isActive = isActive === "true";

    const skip = (page - 1) * limit;

    const competitions = await CompetitionModel.find(query)
      .populate("puzzles", "title difficulty category type")
      .populate("createdBy", "name email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await CompetitionModel.countDocuments(query);

    res.status(200).json({
      success: true,
      data: competitions,
      pagination: {
        current: parseInt(page),
        total: Math.ceil(total / limit),
        count: competitions.length,
        totalRecords: total
      }
    });
  } catch (error) {
    console.error("Error fetching competitions:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch competitions",
    });
  }
};

// Get puzzles with advanced filtering for competition creation
export const getPuzzlesForCompetition = async (req, res) => {
  try {
    const {
      category,
      difficulty,
      type,
      search,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const query = {};

    // Apply filters
    if (category && category !== 'all') query.category = category;
    if (difficulty && difficulty !== 'all') query.difficulty = difficulty;
    if (type && type !== 'all') query.type = type;

    // Search functionality
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (page - 1) * limit;
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const puzzles = await PuzzleModel.find(query)
      .populate("createdBy", "name")
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit));

    const total = await PuzzleModel.countDocuments(query);

    // Get filter options for frontend
    const categories = await PuzzleModel.distinct('category');
    const difficulties = await PuzzleModel.distinct('difficulty');
    const types = await PuzzleModel.distinct('type');

    res.status(200).json({
      success: true,
      data: puzzles,
      pagination: {
        current: parseInt(page),
        total: Math.ceil(total / limit),
        count: puzzles.length,
        totalRecords: total
      },
      filters: {
        categories: categories.filter(Boolean),
        difficulties: difficulties.filter(Boolean),
        types: types.filter(Boolean)
      }
    });
  } catch (error) {
    console.error("Error fetching puzzles:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch puzzles",
    });
  }
};

// Get competition by ID
export const getCompetitionById = async (req, res) => {
  try {
    const { id } = req.params;

    const competition = await CompetitionModel.findById(id)
      .populate("puzzles")
      .populate("participants.user", "name email")
      .populate("createdBy", "name email");

    if (!competition) {
      return res.status(404).json({
        success: false,
        message: "Competition not found",
      });
    }

    res.status(200).json({
      success: true,
      data: competition,
    });
  } catch (error) {
    console.error("Error fetching competition:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch competition",
    });
  }
};

// Update competition
export const updateCompetition = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const competition = await CompetitionModel.findById(id);
    if (!competition) {
      return res.status(404).json({ message: "Competition not found" });
    }

    // Validate puzzles if being updated
    if (updates.puzzles && updates.puzzles.length > 0) {
      const existingPuzzles = await PuzzleModel.find({
        _id: { $in: updates.puzzles },
      });
      if (existingPuzzles.length !== updates.puzzles.length) {
        return res.status(400).json({
          message: "Some puzzles do not exist",
        });
      }
    }

    // Calculate endTime if startTime or duration is being updated
    if (updates.startTime || updates.duration) {
      const start = new Date(updates.startTime || competition.startTime);
      const durationInMinutes = parseInt(updates.duration || competition.duration);
      const end = new Date(start.getTime() + durationInMinutes * 60 * 1000);
      updates.endTime = end;
    }

    // Update status based on times if they're being changed
    if (updates.startTime || updates.endTime || updates.duration) {
      const now = new Date();
      const start = new Date(updates.startTime || competition.startTime);
      const end = new Date(updates.endTime || competition.endTime);

      if (now >= start && now <= end) {
        updates.status = "live";
        updates.isActive = true;
      } else if (now > end) {
        updates.status = "completed";
        updates.isActive = false;
      } else {
        updates.status = "upcoming";
        updates.isActive = false;
      }
    }

    updates.updatedAt = new Date();

    Object.assign(competition, updates);
    // Explicitly handle unsetting accessCode if sent as empty string or null (optional, usually updates just overwrite)
    if (updates.accessCode === "") competition.accessCode = undefined;

    await competition.save();

    res.status(200).json({
      message: "Competition updated successfully",
      competition,
    });
  } catch (error) {
    console.error("Error updating competition:", error);
    res.status(500).json({ message: "Failed to update competition" });
  }
};

// Delete competition
export const deleteCompetition = async (req, res) => {
  try {
    const { id } = req.params;

    const competition = await CompetitionModel.findByIdAndDelete(id);
    if (!competition) {
      return res.status(404).json({ message: "Competition not found" });
    }

    res.status(200).json({ message: "Competition deleted successfully" });
  } catch (error) {
    console.error("Error deleting competition:", error);
    res.status(500).json({ message: "Failed to delete competition" });
  }
};

// Join competition (for users)
export const joinCompetition = async (req, res) => {
  try {
    const { id } = req.params;
    const { accessCode } = req.body;
    const userId = req.user._id;

    const competition = await CompetitionModel.findById(id);
    if (!competition) {
      return res.status(404).json({ message: "Competition not found" });
    }

    // 1. Strict Status Check: Only UPCOMING competitions can be joined
    if (competition.status !== "upcoming") {
      return res.status(400).json({
        message: "Cannot join this competition. It check if it has already started or ended."
      });
    }

    // 2. Check Access Code
    if (competition.accessCode && competition.accessCode !== accessCode) {
      return res.status(403).json({ message: "Invalid access code", requireCode: true });
    }

    // 3. Check if already joined (via ParticipantModel)
    const existingParticipant = await ParticipantModel.findOne({
      competitionId: id,
      userId: userId
    });

    if (existingParticipant) {
      return res.status(400).json({ message: "Already joined this competition" });
    }

    // 4. Check max participants
    if (competition.maxParticipants) {
      const count = await ParticipantModel.countDocuments({ competitionId: id });
      if (count >= competition.maxParticipants) {
        return res.status(400).json({ message: "Competition is full" });
      }
    }

    // 5. Create Participant Entry
    await ParticipantModel.create({
      competitionId: id,
      userId: userId,
      username: req.user.username || req.user.name, // Fallback
      status: 'waiting',
      joinedAt: new Date()
    });

    // 6. Sync with embedded array (Legacy Support)
    competition.participants.push({
      user: userId,
      score: 0,
      completedPuzzles: [],
      joinedAt: new Date(),
    });

    await competition.save();

    res.status(200).json({
      message: "Joined competition successfully",
      competition,
    });
  } catch (error) {
    console.error("Error joining competition:", error);
    res.status(500).json({ message: "Failed to join competition" });
  }
};

// Submit puzzle solution in competition
export const submitSolution = async (req, res) => {
  try {
    const { id, puzzleId } = req.params;
    const { moves, timeTaken } = req.body;
    const userId = req.user._id;

    const competition = await CompetitionModel.findById(id).populate("puzzles");
    if (!competition) {
      return res.status(404).json({ message: "Competition not found" });
    }

    // Find participant
    const participant = competition.participants.find(
      (p) => p.user.toString() === userId.toString()
    );

    if (!participant) {
      return res
        .status(400)
        .json({ message: "Not a participant in this competition" });
    }

    // Check if puzzle already completed
    if (participant.completedPuzzles.includes(puzzleId)) {
      return res.status(400).json({ message: "Puzzle already completed" });
    }

    // Verify puzzle is part of competition
    const puzzle = competition.puzzles.find(
      (p) => p._id.toString() === puzzleId
    );
    if (!puzzle) {
      return res
        .status(400)
        .json({ message: "Puzzle not part of this competition" });
    }

    // Validate solution (simplified - you can enhance this)
    const isCorrect =
      JSON.stringify(moves) === JSON.stringify(puzzle.solutionMoves);

    if (isCorrect) {
      participant.completedPuzzles.push(puzzleId);
      // Calculate score based on difficulty and time
      let points = 10;
      if (puzzle.difficulty === "medium") points = 20;
      if (puzzle.difficulty === "hard") points = 30;

      // Time bonus (if solved quickly)
      if (timeTaken < 30) points += 5;

      participant.score += points;

      await competition.save();

      // Emit update to lobby
      if (req.io) {
        req.io.to(`competition_${id}`).emit('participantUpdate', {
          userId,
          score: participant.score,
          status: participant.status
        });

        // Also refresh leaderboard if necessary
        // req.io.to(`competition_${id}`).emit('leaderboardUpdate', ...);
      }

      res.status(200).json({
        message: "Solution correct!",
        points,
        totalScore: participant.score,
      });
    } else {
      res.status(400).json({ message: "Incorrect solution" });
    }
  } catch (error) {
    console.error("Error submitting solution:", error);
    res.status(500).json({ message: "Failed to submit solution" });
  }
};

// Finish participation (User manually finishes)
export const finishParticipation = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const competition = await CompetitionModel.findById(id);
    if (!competition) {
      return res.status(404).json({ message: "Competition not found" });
    }

    const participant = competition.participants.find(
      (p) => p.user.toString() === userId.toString()
    );

    if (!participant) {
      return res.status(400).json({ message: "Not a participant" });
    }

    // Update internal status
    participant.status = 'submitted'; // or 'completed'
    // Update standalone model too
    await ParticipantModel.findOneAndUpdate(
      { competitionId: id, userId: userId },
      { status: 'submitted', lastActivity: new Date() }
    );

    await competition.save();

    if (req.io) {
      req.io.to(`competition_${id}`).emit('participantUpdate', {
        userId,
        status: 'submitted'
      });
    }

    res.status(200).json({ message: "Competition finished successfully" });
  } catch (error) {
    console.error("Error finishing competition:", error);
    res.status(500).json({ message: "Failed to finish competition" });
  }
};

// Get leaderboard
export const getLeaderboard = async (req, res) => {
  try {
    const { id } = req.params;

    const competition = await CompetitionModel.findById(id).populate(
      "participants.user",
      "name email"
    );

    if (!competition) {
      return res.status(404).json({ message: "Competition not found" });
    }

    // Sort participants by score
    const leaderboard = competition.participants
      .sort((a, b) => b.score - a.score)
      .map((p, index) => ({
        rank: index + 1,
        user: p.user,
        score: p.score,
        completedPuzzles: p.completedPuzzles.length,
        joinedAt: p.joinedAt,
      }));

    res.status(200).json({
      competition: {
        name: competition.name,
        status: competition.status,
      },
      leaderboard,
    });
  } catch (error) {
    console.error("Error fetching leaderboard:", error);
    res.status(500).json({ message: "Failed to fetch leaderboard" });
  }
};

export default {
  createCompetition,
  getCompetitions,
  getCompetitionById,
  updateCompetition,
  deleteCompetition,
  joinCompetition,
  submitSolution,
  finishParticipation,
  getLeaderboard,
  getPuzzlesForCompetition,
};
