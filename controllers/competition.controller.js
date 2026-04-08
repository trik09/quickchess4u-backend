import CompetitionModel from "../models/CompetitionSchema.js";
import PuzzleModel from "../models/PuzzleSchema.js";
import ParticipantModel from "../models/ParticipantSchema.js";
import { addParticipantToLeaderboard } from "../utils/socketHandlers.js";

// Create a new competition
export const createCompetition = async (req, res) => {
  try {
    const { name, description, startTime, duration, puzzles, maxParticipants, accessCode, chapters } =
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

    // Determine status based on start time (use uppercase to match schema enum)
    const now = new Date();

    let status = "UPCOMING";
    let isActive = false;

    if (now >= start && now <= end) {
      status = "LIVE";
      isActive = true;
    } else if (now > end) {
      status = "ENDED";
      isActive = false;
    }

    const competition = await CompetitionModel.create({
      name,
      description,
      startTime,
      endTime: end,
      duration: durationInMinutes,
      puzzles: puzzles || [],
      chapters: chapters || [],
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

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const now = new Date();

    // Build a time-aware query so late-starting competitions are never missed.
    // A competition is effectively LIVE if:
    //   - DB status is LIVE, OR
    //   - DB status is UPCOMING but startTime has already passed and endTime hasn't
    // A competition is effectively UPCOMING if:
    //   - DB status is UPCOMING and startTime is still in the future
    const query = {};

    if (status) {
      const s = status.toUpperCase();
      if (s === "LIVE") {
        query.$or = [
          { status: "LIVE" },
          // Catch stale UPCOMING competitions that have already started
          { status: "UPCOMING", startTime: { $lte: now }, endTime: { $gt: now } },
        ];
      } else if (s === "UPCOMING") {
        // Only truly upcoming (startTime still in the future)
        query.status = "UPCOMING";
        query.startTime = { $gt: now };
      } else {
        query.status = s;
      }
    }

    if (isActive !== undefined) query.isActive = isActive === "true";

    const skip = (pageNum - 1) * limitNum;

    const [competitions, total] = await Promise.all([
      CompetitionModel.find(query)
        .select(
          "name description status startTime endTime duration puzzles participants maxParticipants createdAt"
        )
        .populate("puzzles")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),

      CompetitionModel.countDocuments(query),
    ]);

    // Async: promote any stale UPCOMING→LIVE competitions in the DB so next poll is clean
    const staleUpcoming = competitions.filter(
      (c) => c.status === "UPCOMING" && new Date(c.startTime) <= now && new Date(c.endTime) > now
    );
    if (staleUpcoming.length) {
      CompetitionModel.updateMany(
        { _id: { $in: staleUpcoming.map((c) => c._id) } },
        { status: "LIVE", isActive: true }
      ).catch(() => {});
    }

    // Get accurate participant counts from ParticipantModel (live system)
    const competitionIds = competitions.map((c) => c._id);
    const participantCounts = await ParticipantModel.aggregate([
      { $match: { competitionId: { $in: competitionIds } } },
      { $group: { _id: "$competitionId", count: { $sum: 1 } } },
    ]);
    const countMap = new Map(participantCounts.map((p) => [p._id.toString(), p.count]));

    const enriched = competitions.map((c) => {
      // Compute effective status from time so the frontend always gets the truth
      let effectiveStatus = c.status;
      const start = new Date(c.startTime);
      const end = new Date(c.endTime);
      if (c.status === "UPCOMING" && start <= now && end > now) {
        effectiveStatus = "LIVE";
      }

      return {
        ...c,
        status: effectiveStatus,
        participantCount: countMap.get(c._id.toString()) ?? c.participants?.length ?? 0,
        participants: undefined,
      };
    });

    res.status(200).json({
      success: true,
      data: enriched,
      pagination: {
        current: pageNum,
        total: Math.ceil(total / limitNum),
        count: competitions.length,
        totalRecords: total,
      },
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
      level,
      rating,
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
    if (level && level !== 'all') query.level = parseInt(level);
    if (rating && rating !== 'all') query.rating = parseInt(rating);

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
    const levels = await PuzzleModel.distinct('level');
    const ratings = await PuzzleModel.distinct('rating');

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
        types: types.filter(Boolean),
        levels: levels.filter(val => val !== null && val !== undefined).sort((a, b) => a - b),
        ratings: ratings.filter(val => val !== null && val !== undefined).sort((a, b) => a - b)
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
      .populate("createdBy", "name email")
      .populate("participants.user", "name email");

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

    // Validate puzzles if being updated (allow empty array)
    if (updates.puzzles !== undefined) {
      if (Array.isArray(updates.puzzles) && updates.puzzles.length > 0) {
        const existingPuzzles = await PuzzleModel.find({
          _id: { $in: updates.puzzles },
        });
        if (existingPuzzles.length !== updates.puzzles.length) {
          return res.status(400).json({
            message: "Some puzzles do not exist",
          });
        }
      }
      // Empty array is valid (allow removing all puzzles)
    }

    // Calculate endTime if startTime or duration is being updated
    if (updates.startTime || updates.duration) {
      const start = new Date(updates.startTime || competition.startTime);

      const durationInMinutes =
        updates.duration !== undefined && updates.duration !== ""
          ? parseInt(updates.duration)
          : competition.duration;

      if (isNaN(durationInMinutes)) {
        return res.status(400).json({ message: "Invalid duration value" });
      }

      updates.duration = durationInMinutes;
      updates.endTime = new Date(start.getTime() + durationInMinutes * 60 * 1000);
    }

    // Update status based on times if they're being changed
    if (updates.startTime || updates.endTime || updates.duration) {
      const now = new Date();
      const start = new Date(updates.startTime || competition.startTime);
      const end = new Date(updates.endTime || competition.endTime);

      if (now >= start && now <= end) {
        updates.status = "LIVE"; // Use uppercase to match schema enum
        updates.isActive = true;
      } else if (now > end) {
        updates.status = "ENDED";
        updates.isActive = false;
      } else {
        updates.status = "UPCOMING"; // Use uppercase to match schema enum
        updates.isActive = false;
      }
    }

    updates.updatedAt = new Date();

    // Only assign valid fields to prevent schema validation errors
    const allowedFields = ['name', 'description', 'startTime', 'endTime', 'duration', 'puzzles', 'chapters', 'maxParticipants', 'status', 'isActive', 'accessCode', 'updatedAt'];
    const validUpdates = {};
    allowedFields.forEach(field => {
      if (updates[field] !== undefined) {
        // Handle special cases
        if (field === 'maxParticipants' && (updates[field] === '' || updates[field] === null)) {
          validUpdates[field] = undefined; // Allow unsetting
        } else if (field === 'maxParticipants' && typeof updates[field] === 'string') {
          validUpdates[field] = parseInt(updates[field]) || undefined;
        } else {
          validUpdates[field] = updates[field];
        }
      }
    });

    Object.assign(competition, validUpdates);

    // Explicitly handle unsetting accessCode if sent as empty string or null
    if (updates.accessCode === "" || updates.accessCode === null) {
      competition.accessCode = undefined;
    }

    await competition.save();

    res.status(200).json({
      message: "Competition updated successfully",
      competition,
    });
  } catch (error) {
    console.error("Error updating competition:", error);
    res.status(500).json({
      message: "Failed to update competition",
      error: error.message || "Unknown error occurred"
    });
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
    console.log(accessCode);
    const userId = req.user._id;

    const competition = await CompetitionModel.findById(id);
    if (!competition) {
      return res.status(404).json({ message: "Competition not found" });
    }

    // 🔄 Recalculate active status based on current time to avoid stale `isActive`
    const now = new Date();
    const start = new Date(competition.startTime);
    const end = new Date(competition.endTime);

    const isWithinWindow = now >= start && now <= end;

    if (!isWithinWindow) {
      return res.status(400).json({ message: "Competition is not active" });
    }

    // Ensure stored status flags are in sync when user joins
    if (competition.status !== "LIVE" || !competition.isActive) {
      competition.status = "LIVE";
      competition.isActive = true;
    }

    // Check Access Code
    if (competition.accessCode && competition.accessCode !== accessCode) {
      return res.status(403).json({ message: "Invalid access code", requireCode: true });
    }

    // Check if already joined
    const alreadyJoined = competition.participants.some(
      (p) => p.user.toString() === userId.toString()
    );

    if (alreadyJoined) {
      return res
        .status(400)
        .json({ message: "Already joined this competition" });
    }

    // Check max participants
    if (
      competition.maxParticipants &&
      competition.participants.length >= competition.maxParticipants
    ) {
      return res.status(400).json({ message: "Competition is full" });
    }

    // Ensure ParticipantModel entry exists as well (Unified system)
    let participant = await ParticipantModel.findOne({ competitionId: id, userId });
    
    if (!participant) {
      participant = await ParticipantModel.create({
        competitionId: id,
        userId,
        username: req.user.username || req.user.name,
        status: "JOINED",
        joinedAt: new Date(),
        score: 0,
        puzzlesSolved: 0,
        timeSpent: 0,
      });

      // Sync to Redis and Broadcast
      setImmediate(async () => {
        try {
          await addParticipantToLeaderboard(id, participant);
        } catch (err) {
          console.error("Redis sync error in joinCompetition:", err);
        }
      });
    }

    competition.participants.push({
      user: userId,
      score: 0,
      ENDEDPuzzles: [],
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

    // Check if puzzle already ENDED
    if (participant.ENDEDPuzzles.includes(puzzleId)) {
      return res.status(400).json({ message: "Puzzle already ENDED" });
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
      participant.ENDEDPuzzles.push(puzzleId);
      // Calculate score based on difficulty and time
      let points = 10;
      if (puzzle.difficulty === "medium") points = 20;
      if (puzzle.difficulty === "hard") points = 30;

      // Time bonus (if solved quickly)
      if (timeTaken < 30) points += 5;

      participant.score += points;

      await competition.save();

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
        ENDEDPuzzles: p.ENDEDPuzzles.length,
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
  getLeaderboard,
  getPuzzlesForCompetition,
};
