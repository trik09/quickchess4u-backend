import CompetitionModel from "../models/CompetitionSchema.js";
import ParticipantModel from "../models/ParticipantSchema.js";
import PuzzleSolutionModel from "../models/PuzzleSolutionSchema.js";
import PuzzleAttemptModel from "../models/PuzzleAttemptSchema.js";
import PuzzleModel from "../models/PuzzleSchema.js";
import UserModel from "../models/UserSchema.js";
import { io } from "../index.js";
import redis from "../config/redis.js";

import { scheduleCompetitionEnd, getCurrentLeaderboard, handleCompetitionEnd,upsertLeaderboardEntry, addParticipantToLeaderboard, getIO, leaderboardKey, redisScore } from "../utils/socketHandlers.js";

// Participate in live competition (REST API validation)
export const participateInCompetition = async (req, res) => {
  try {
    const { competitionId } = req.params;
    const { username, accessCode } = req.body;
    const userId = req.user._id;

    // Fetch competition with minimal fields
    const competition = await CompetitionModel.findById(competitionId)
      .select(
        "name description startTime endTime duration status accessCode maxParticipants puzzles chapters"
      )
      .lean();

    if (!competition) {
      return res.status(404).json({
        success: false,
        error: "Competition not found",
      });
    }

    const now = new Date();

    if (competition.status === "ENDED" || now > competition.endTime) {
      return res.status(400).json({
        success: false,
        error: "Competition has ended",
      });
    }

    // Access code validation
    if (competition.accessCode && competition.accessCode.trim() !== "") {
      if (!accessCode || accessCode.trim() !== competition.accessCode.trim()) {
        return res.status(403).json({
          success: false,
          error: "Invalid access code",
          requireCode: true,
        });
      }
    }

    // Run queries in parallel
    const [participantCount, existingParticipant] = await Promise.all([
      ParticipantModel.countDocuments({ competitionId }),
      ParticipantModel.findOne({ competitionId, userId }).lean(),
    ]);

    // Max participant validation
    if (
      competition.maxParticipants &&
      participantCount >= competition.maxParticipants
    ) {
      return res.status(400).json({
        success: false,
        error: "Competition is full",
      });
    }

    // If already participating
    if (existingParticipant) {
      if (existingParticipant.submittedAt) {
        return res.status(400).json({
          success: false,
          message: "You have already submitted this competition",
        });
      }

      return res.json({
        success: true,
        message: "Already participating",
        competition: {
          id: competition._id,
          name: competition.name,
          description: competition.description,
          startTime: competition.startTime,
          endTime: competition.endTime,
          duration: competition.duration,
          status: competition.status,
          participantCount,
        },
      });
    }

    // Create participant
    const participant = await ParticipantModel.create({
      competitionId,
      userId,
      username: username || req.user.username || req.user.name,
      status: "JOINED",
      joinedAt: new Date(),
      score: 0,
      puzzlesSolved: 0,
      timeSpent: 0,
    });

    // Unified system: Sync back to legacy Competition.participants array
    try {
      await CompetitionModel.findByIdAndUpdate(competitionId, {
        $push: {
          participants: {
            user: userId,
            score: 0,
            joinedAt: new Date(),
          }
        }
      });
    } catch (err) {
      console.error("Legacy participant sync error:", err);
    }

    // Send response immediately
    res.json({
      success: true,
      competition: {
        id: competition._id,
        name: competition.name,
        description: competition.description,
        startTime: competition.startTime,
        endTime: competition.endTime,
        duration: competition.duration,
        puzzles: competition.puzzles,
        chapters: competition.chapters || [],
        maxScore: (competition.puzzles?.length || 0) * 10,
        status: competition.status,
        participantCount: participantCount + 1,
      },
    });

    // Run Redis + Socket operations in background
    setImmediate(async () => {
      try {
        // Always keep Redis leaderboard in sync so lobby views
        // (which may read from Redis cache) see ALL participants,
        // even while the competition is still UPCOMING.
        await addParticipantToLeaderboard(competition._id, participant);

        const roomName = `competition_${competitionId}`;

        io.to(roomName).emit("participantJoined", {
          username: participant.username,
          userId: participant.userId.toString(),
        });

        // Broadcast latest leaderboard to everyone in the room.
        // Note: addParticipantToLeaderboard already emits a
        // "leaderboardUpdate" event after syncing Redis, so this
        // extra emit is mainly a safety net and can be removed
        // later if desired.
        const leaderboard = await getCurrentLeaderboard(competitionId);
        io.to(roomName).emit("leaderboardUpdate", leaderboard);
      } catch (err) {
        console.error("Background event error:", err);
      }
    });
  } catch (error) {
    console.error("Participation error:", error);

    res.status(500).json({
      success: false,
      error: "Server error during participation",
    });
  }
};


export const submitCompetition = async (req, res) => {
  try {
    const { competitionId } = req.params;
    const userId = req.user._id;

    // ── Validate competition ──────────────────────────────────────────────────
    const competition = await CompetitionModel.findById(competitionId);
    if (!competition) {
      return res.status(404).json({
        success: false,
        message: "Competition not found",
      });
    }

    if (
      competition.status !== "live" &&
      competition.status !== "LIVE"
    ) {
      return res.status(400).json({
        success: false,
        message: "Competition is not currently active",
      });
    }

    // ── Validate participant ──────────────────────────────────────────────────
    const participant = await ParticipantModel.findOne({
      competitionId,
      userId,
    });

    if (!participant) {
      return res.status(404).json({
        success: false,
        message: "You are not participating in this competition",
      });
    }

    // ── Mark as submitted ─────────────────────────────────────────────────────
    const submittedAt = new Date();
    participant.submittedAt = submittedAt;
    participant.isActive    = false;
    participant.isSubmitted = true;
    participant.status      = "SUBMITTED";

    // Compute actual elapsed time
    const effectiveStart = (() => {
      const start =
        competition.startTime instanceof Date
          ? competition.startTime
          : new Date(competition.startTime);

      return participant.joinedAt && participant.joinedAt > start
        ? participant.joinedAt
        : start;
    })();

    if (effectiveStart) {
      const elapsedMs = submittedAt.getTime() - effectiveStart.getTime();
      if (elapsedMs > 0) {
        participant.timeSpent = Math.floor(elapsedMs / 1000);
      }
    }

    await participant.save();

    // ── ✅ Sync Redis with safe upsert (no more JSON-string duplicates) ───────
    try {
      await upsertLeaderboardEntry(competitionId, {
        userId       : participant.userId.toString(),
        username     : participant.username,
        score        : participant.score        || 0,
        puzzlesSolved: participant.puzzlesSolved || 0,
        timeSpent    : participant.timeSpent     || 0,
        status       : "SUBMITTED",
        submittedAt  : participant.submittedAt,
      });
    } catch (redisError) {
      console.error(
        "[Leaderboard] Redis upsert error in submitCompetition:",
        redisError
      );
    }

    // ── Broadcast updated leaderboard ─────────────────────────────────────────
    const roomName = `competition_${competitionId}`;

    getCurrentLeaderboard(competitionId)
      .then((updatedLeaderboard) => {
        io.to(roomName).emit("leaderboardUpdate", updatedLeaderboard);
      })
      .catch((err) =>
        console.error("[Leaderboard] Submit leaderboard broadcast error:", err)
      );

    io.to(roomName).emit("participantSubmitted", {
      username     : participant.username,
      score        : participant.score,
      puzzlesSolved: participant.puzzlesSolved,
      timeSpent    : participant.timeSpent,
    });

    // ── Check if ALL participants have submitted ───────────────────────────────
    const totalParticipants = await ParticipantModel.countDocuments({
      competitionId,
    });
    const submittedParticipants = await ParticipantModel.countDocuments({
      competitionId,
      $or: [
        { isSubmitted: true },
        { submittedAt: { $exists: true } },
      ],
    });

    // Send response first, then optionally end competition
    res.json({
      success      : true,
      message      : "Competition submitted successfully",
      finalScore   : participant.score,
      puzzlesSolved: participant.puzzlesSolved,
      timeSpent    : participant.timeSpent,
    });

    // End competition early if everyone has submitted
    if (totalParticipants > 0 && submittedParticipants >= totalParticipants) {
      console.log("All participants submitted. Ending competition early.");
      setTimeout(() => {
        handleCompetitionEnd(io, competitionId);
      }, 100);
    }
  } catch (error) {
    console.error("[Controller] Competition submission error:", error);
    res.status(500).json({
      success: false,
      error  : "Server error during submission",
    });
  }
};

/* =========================================================
   SUBMIT PUZZLE SOLUTION
========================================================= */
export const submitPuzzleSolution = async (req, res) => {
  try {
    const { competitionId, puzzleId } = req.params;
    const { solution, timeSpent, boardPosition, moveHistory } = req.body;
    const userId = req.user._id;

    /* ── Competition check ───────────────────────────────────────────────── */
    const competition = await CompetitionModel.findById(competitionId);
    if (!competition || new Date() > competition.endTime) {
      return res.status(400).json({
        success: false,
        message: "Competition has ended",
      });
    }

    const now        = new Date();
    const isTimeLive =
      now >= competition.startTime && now <= competition.endTime;

    if (competition.status !== "LIVE" && !isTimeLive) {
      return res.status(400).json({
        success: false,
        message: "Competition is not live",
      });
    }

    // Fix stale DB status asynchronously
    if (competition.status !== "LIVE" && isTimeLive) {
      CompetitionModel.updateOne(
        { _id: competitionId },
        { status: "LIVE", isActive: true }
      ).catch(() => {});
    }

    /* ── Participant check ───────────────────────────────────────────────── */
    const participant = await ParticipantModel.findOne({
      competitionId,
      userId,
    });

    if (!participant) {
      return res.status(404).json({
        success: false,
        message: "You are not participating in this competition",
      });
    }

    if (participant.status === "SUBMITTED") {
      return res.status(400).json({
        success: false,
        message: "You have already submitted the competition",
      });
    }

    /* ── Duplicate attempt check ─────────────────────────────────────────── */
    const existingAttempt = await PuzzleAttemptModel.findOne({
      competitionId,
      puzzleId,
      userId,
    });

    if (
      existingAttempt &&
      (existingAttempt.status === "solved" ||
        existingAttempt.status === "failed")
    ) {
      return res.status(400).json({
        success    : false,
        message    : `Puzzle already ${existingAttempt.status}`,
        puzzleStatus: existingAttempt.status,
      });
    }

    /* ── Puzzle check ────────────────────────────────────────────────────── */
    const puzzle = await PuzzleModel.findById(puzzleId);
    if (!puzzle) {
      return res.status(404).json({
        success: false,
        message: "Puzzle not found",
      });
    }

    const isCorrect = validatePuzzleSolution(puzzle, solution);

    /* ── Mark player as PLAYING on first solve attempt ───────────────────── */
    if (participant.status === "JOINED") {
      participant.status = "PLAYING";
      await participant.save();

      io.to(`competition_${competitionId}`).emit("player-progress", {
        userId,
        participantState: "PLAYING",
      });
    }

    /* ── Elapsed time ────────────────────────────────────────────────────── */
    const effectiveStart = new Date(
      Math.max(
        new Date(competition.startTime).getTime(),
        new Date(participant.joinedAt || new Date()).getTime()
      )
    ).getTime();

    const currentTotalTime = Math.max(
      0,
      Math.floor((Date.now() - effectiveStart) / 1000)
    );

    /* ═══════════════════════════════════════════════════════════════════════
       CORRECT SOLUTION
    ═══════════════════════════════════════════════════════════════════════ */
    if (isCorrect) {
      const scoreEarned = calculateScore(puzzle.difficulty, timeSpent);

      // Save puzzle attempt
      await PuzzleAttemptModel.findOneAndUpdate(
        { competitionId, puzzleId, userId },
        {
          status      : "solved",
          solution,
          boardPosition,
          moveHistory : moveHistory || [],
          timeSpent,
          scoreEarned,
          isLocked    : true,
          completedAt : new Date(),
        },
        { upsert: true, new: true }
      );

      // Backward-compat solution record
      await new PuzzleSolutionModel({
        competitionId,
        puzzleId,
        userId,
        solution,
        timeSpent,
        scoreEarned,
        isCorrect: true,
        solvedAt : new Date(),
      }).save();

      // Update participant score in DB
      const updatedParticipant = await ParticipantModel.findOneAndUpdate(
        { competitionId, userId },
        {
          $inc: { score: scoreEarned, puzzlesSolved: 1 },
          $set: { timeSpent: currentTotalTime, lastActivity: new Date() },
        },
        { new: true }
      );

      // ── ✅ Sync Redis with safe upsert ──────────────────────────────────
      try {
        await upsertLeaderboardEntry(competitionId, {
          userId       : updatedParticipant.userId.toString(),
          username     : updatedParticipant.username,
          score        : updatedParticipant.score        || 0,
          puzzlesSolved: updatedParticipant.puzzlesSolved || 0,
          timeSpent    : updatedParticipant.timeSpent     || 0,
          status       : updatedParticipant.status        || "PLAYING",
          submittedAt  : updatedParticipant.submittedAt   || null,
        });
      } catch (redisError) {
        console.error(
          "[Leaderboard] Redis upsert error in submitPuzzleSolution:",
          redisError
        );
      }

      // ── Broadcast leaderboard + live score update ───────────────────────
      getCurrentLeaderboard(competitionId)
        .then((leaderboard) => {
          io.to(`competition_${competitionId}`).emit(
            "leaderboardUpdate",
            leaderboard
          );
        })
        .catch((err) =>
          console.error("[Leaderboard] Puzzle solve broadcast error:", err)
        );

      io.to(`competition_${competitionId}`).emit("liveScoreUpdate", {
        userId       : updatedParticipant.userId,
        username     : updatedParticipant.username,
        score        : updatedParticipant.score,
        puzzlesSolved: updatedParticipant.puzzlesSolved,
        timeSpent    : updatedParticipant.timeSpent,
        status       : updatedParticipant.status,
      });

      return res.json({
        success      : true,
        isCorrect    : true,
        scoreEarned,
        totalScore   : updatedParticipant.score,
        puzzlesSolved: updatedParticipant.puzzlesSolved,
        puzzleStatus : "solved",
        message      : "Puzzle solved successfully!",
      });
    }

    /* ═══════════════════════════════════════════════════════════════════════
       INCORRECT SOLUTION
    ═══════════════════════════════════════════════════════════════════════ */
    await PuzzleAttemptModel.findOneAndUpdate(
      { competitionId, puzzleId, userId },
      {
        status      : "failed",
        solution,
        boardPosition,
        moveHistory : moveHistory || [],
        timeSpent,
        scoreEarned : 0,
        isLocked    : true,
        completedAt : new Date(),
      },
      { upsert: true, new: true }
    );

    // Update only time spent (no score change)
    const updatedParticipant = await ParticipantModel.findOneAndUpdate(
      { competitionId, userId },
      {
        $set: { timeSpent: currentTotalTime, lastActivity: new Date() },
      },
      { new: true }
    );

    // ── ✅ Still upsert Redis so timeSpent stays accurate ───────────────────
    // This also ensures the user is never dropped from the sorted set
    // just because they got a puzzle wrong.
    try {
      await upsertLeaderboardEntry(competitionId, {
        userId       : updatedParticipant.userId.toString(),
        username     : updatedParticipant.username,
        score        : updatedParticipant.score        || 0,
        puzzlesSolved: updatedParticipant.puzzlesSolved || 0,
        timeSpent    : updatedParticipant.timeSpent     || 0,
        status       : updatedParticipant.status        || "PLAYING",
        submittedAt  : updatedParticipant.submittedAt   || null,
      });
    } catch (redisError) {
      console.error(
        "[Leaderboard] Redis upsert error on wrong answer:",
        redisError
      );
    }

    return res.json({
      success      : false,
      isCorrect    : false,
      scoreEarned  : 0,
      totalScore   : updatedParticipant.score,
      puzzlesSolved: updatedParticipant.puzzlesSolved,
      puzzleStatus : "failed",
      message      : "Incorrect solution.",
    });
  } catch (error) {
    console.error("[Controller] Puzzle submission error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during submission",
    });
  }
};


// Get live leaderboard
export const getLiveLeaderboard = async (req, res) => {
  try {
    const { competitionId } = req.params;
    const userId = req.user?._id;

    // Fetch competition with minimal fields
    const competition = await CompetitionModel.findById(competitionId)
      .select("name status startTime endTime")
      .lean();

    if (!competition) {
      return res.status(404).json({
        success: false,
        message: "Competition not found",
      });
    }

    // Run leaderboard + participant queries in parallel
    const [leaderboard, participant] = await Promise.all([
      getCurrentLeaderboard(competitionId),
      userId
        ? ParticipantModel.findOne({ competitionId, userId })
          .select("status")
          .lean()
        : null,
    ]);

    const participantState = participant ? participant.status : "NOT_JOINED";

    res.json({
      success: true,
      competition: {
        id: competition._id,
        name: competition.name,
        status: competition.status,
        startTime: competition.startTime,
        endTime: competition.endTime,
      },
      competitionState: competition.status,
      participantState,
      leaderboard,
      serverTime: Date.now(),
    });
  } catch (error) {
    console.error("Error fetching live leaderboard:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch leaderboard",
    });
  }
};

// Get competition puzzles for participants
export const getCompetitionPuzzles = async (req, res) => {
  try {
    const { competitionId } = req.params;
    const userId = req.user._id;

    // Validate competition and participation
    const competition = await CompetitionModel.findById(competitionId).populate('puzzles');
    if (!competition) {
      return res.status(404).json({
        success: false,
        message: 'Competition not found'
      });
    }

    // Check if user is a participant
    const participant = await ParticipantModel.findOne({
      competitionId,
      userId
    });

    if (!participant) {
      return res.status(403).json({
        success: false,
        message: 'Not a participant in this competition'
      });
    }

    // Get user's puzzle attempts (includes solved, failed, and in-progress)
    const puzzleAttempts = await PuzzleAttemptModel.find({
      competitionId,
      userId
    }).select('puzzleId status scoreEarned timeSpent completedAt boardPosition moveHistory isLocked');

    console.log('Found puzzle attempts for user:', userId, puzzleAttempts.length);
    puzzleAttempts.forEach(attempt => {
      console.log('Attempt:', {
        puzzleId: attempt.puzzleId,
        status: attempt.status,
        isLocked: attempt.isLocked
      });
    });

    // Create attempts map for quick lookup
    const attemptsMap = new Map();
    puzzleAttempts.forEach(attempt => {
      attemptsMap.set(attempt.puzzleId.toString(), {
        status: attempt.status,
        scoreEarned: attempt.scoreEarned || 0,
        timeSpent: attempt.timeSpent || 0,
        completedAt: attempt.completedAt,
        boardPosition: attempt.boardPosition,
        moveHistory: attempt.moveHistory || [],
        isLocked: attempt.isLocked
      });
    });

    // Get user's solved puzzles (for backward compatibility)
    const solvedPuzzles = await PuzzleSolutionModel.find({
      competitionId,
      userId,
      isCorrect: true
    }).select('puzzleId scoreEarned timeSpent solvedAt');

    // Create solved puzzles map for quick lookup
    const solvedMap = new Map();
    solvedPuzzles.forEach(solution => {
      solvedMap.set(solution.puzzleId.toString(), {
        scoreEarned: solution.scoreEarned,
        timeSpent: solution.timeSpent,
        solvedAt: solution.solvedAt
      });
    });

    // Prepare puzzles with solved status and attempt data
    const puzzlesWithStatus = competition.puzzles.map(puzzle => {
      const puzzleId = puzzle._id.toString();
      const attemptData = attemptsMap.get(puzzleId);
      const solvedData = solvedMap.get(puzzleId);

      // Determine puzzle status
      let status = 'unsolved';
      let isSolved = false;
      let isFailed = false;
      let isLocked = false;

      if (attemptData) {
        status = attemptData.status;
        isSolved = attemptData.status === 'solved';
        isFailed = attemptData.status === 'failed';
        isLocked = attemptData.isLocked || isSolved || isFailed;
      } else if (solvedData) {
        // Backward compatibility for old solved puzzles
        status = 'solved';
        isSolved = true;
        isLocked = true;
      }

      return {
        _id: puzzle._id,
        title: puzzle.title,
        description: puzzle.description,
        difficulty: puzzle.difficulty,
        category: puzzle.category,
        type: puzzle.type,
        fen: puzzle.fen,
        solutionMoves: puzzle.solutionMoves,
        alternativeSolutions: puzzle.alternativeSolutions || [],
        firstMoveBy: puzzle.firstMoveBy || 'human',
        captureConfig: puzzle.captureConfig || puzzle.kidsConfig,
        illegalConfig: puzzle.illegalConfig || null,
        level: puzzle.level,
        rating: puzzle.rating,

        // Status information
        status,
        isSolved,
        isFailed,
        isLocked,

        // Attempt data
        solvedData: attemptData || solvedData || null,
        boardPosition: attemptData?.boardPosition || null,
        moveHistory: attemptData?.moveHistory || []
      };
    });

    console.log('Final puzzles with status:', puzzlesWithStatus.map(p => ({
      id: p._id,
      status: p.status,
      isSolved: p.isSolved,
      isFailed: p.isFailed,
      isLocked: p.isLocked
    })));

    res.json({
      success: true,
      competition: {
        id: competition._id,
        name: competition.name,
        status: competition.status,
        startTime: competition.startTime,
        endTime: competition.endTime,
        totalPuzzles: competition.puzzles.length,
        chapters: competition.chapters || []
      },
      puzzles: puzzlesWithStatus,
      participant: {
        score: participant.score,
        puzzlesSolved: participant.puzzlesSolved,
        timeSpent: participant.timeSpent,
        joinedAt: participant.joinedAt
      }
    });

  } catch (error) {
    console.error('Error fetching competition puzzles:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch competition puzzles'
    });
  }
};

// Start competition (Admin only)
export const startCompetition = async (req, res) => {
  try {
    const { competitionId } = req.params;

    const competition = await CompetitionModel.findById(competitionId);
    if (!competition) {
      return res.status(404).json({
        success: false,
        message: 'Competition not found'
      });
    }

    if (competition.status === 'LIVE') {
      return res.status(400).json({
        success: false,
        message: 'Competition is already live'
      });
    }

    if (competition.status === 'ENDED') {
      return res.status(400).json({
        success: false,
        message: 'Competition has already ended'
      });
    }

    // Update competition status
    competition.status = 'LIVE';
    competition.isActive = true;
    competition.startTime = new Date(); // Start now
    await competition.save();

    // Schedule competition end
    scheduleCompetitionEnd(io, competitionId, competition.endTime);

    res.json({
      success: true,
      message: 'Competition started successfully',
      competition: {
        id: competition._id,
        name: competition.name,
        status: competition.status,
        startTime: competition.startTime,
        endTime: competition.endTime
      }
    });

  } catch (error) {
    console.error('Error starting competition:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to start competition'
    });
  }
};

// Helper function to validate puzzle solution
const validatePuzzleSolution = (puzzle, solution) => {
  try {
    // ── ILLEGAL MOVE PUZZLES ───────────────────────────────────────────────────
    // For this type the frontend fully controls win/lose logic (capture-all vs
    // moving-into-attack). It submits a simple string: 'solved' or 'failed'.
    if (puzzle.type === 'illegal') {
      const result = typeof solution === 'string'
        ? solution
        : (Array.isArray(solution) ? solution[0] : null);
      return result === 'solved';
    }

    // ── NORMAL / KIDS PUZZLES ─────────────────────────────────────────────────
    console.log('Validating solution:', {
      puzzleSolution: puzzle.solutionMoves,
      puzzleSolutionType: typeof puzzle.solutionMoves,
      puzzleIsArray: Array.isArray(puzzle.solutionMoves),
      userSolution: solution,
      userSolutionType: typeof solution,
      userIsArray: Array.isArray(solution)
    });

    // Normalize both solutions to arrays for comparison
    let puzzleMoves = puzzle.solutionMoves;
    let userMoves = solution;

    // Convert to arrays if they're strings
    if (typeof puzzleMoves === 'string') {
      try {
        puzzleMoves = JSON.parse(puzzleMoves);
      } catch (e) {
        puzzleMoves = [puzzleMoves];
      }
    }

    if (typeof userMoves === 'string') {
      try {
        userMoves = JSON.parse(userMoves);
      } catch (e) {
        userMoves = [userMoves];
      }
    }

    // Ensure both are arrays
    if (!Array.isArray(puzzleMoves)) puzzleMoves = [puzzleMoves];
    if (!Array.isArray(userMoves)) userMoves = [userMoves];

    console.log('Normalized for comparison:', {
      puzzleMoves,
      userMoves,
      match: JSON.stringify(puzzleMoves) === JSON.stringify(userMoves)
    });

    return JSON.stringify(puzzleMoves) === JSON.stringify(userMoves);
  } catch (error) {
    console.error('Solution validation error:', error);
    return false;
  }
};

export const getLobbyState = async (req, res) => {
  try {
    const { competitionId } = req.params;
    const userId = req.user._id;
    const now = new Date();

    // 1. Fetch competition (only required fields)
    //console.time("competitionQuery");
    const competition = await CompetitionModel
      .findById(competitionId)
      .select("name startTime endTime duration puzzles status isActive accessCode")
      .lean();
    //console.timeEnd("competitionQuery");

    if (!competition) {
      return res.status(404).json({
        success: false,
        message: "Competition not found"
      });
    }

    // 2. Fetch participant (only status)
    //console.time("participantQuery");
    const participant = await ParticipantModel
      .findOne({ competitionId, userId })
      .select("status")
      .lean();
    //console.timeEnd("participantQuery");

    // 3. Determine competition state
    let competitionState = competition.status?.toUpperCase() || "UPCOMING";

    if (
      competitionState === "UPCOMING" &&
      now >= competition.startTime &&
      now <= competition.endTime
    ) {
      competitionState = "LIVE";

      // Async update (non-blocking)
      CompetitionModel.updateOne(
        { _id: competitionId },
        { status: "LIVE", isActive: true }
      ).catch(() => { });
    }

    if (now > competition.endTime && competitionState !== "ENDED") {
      competitionState = "ENDED";

      CompetitionModel.updateOne(
        { _id: competitionId },
        { status: "ENDED", isActive: false }
      ).catch(() => { });
    }

    // 4. Participant state
    const participantState = participant?.status || "NOT_JOINED";

    // 5. Leaderboard — skip for ENDED competitions (Leaderboard page handles that)
    let leaderboard = [];
    if (competitionState !== "ENDED") {
      leaderboard = await getCurrentLeaderboard(competitionId);
    }

    // 6. Response
    return res.json({
      success: true,
      competition: {
        id: competition._id,
        name: competition.name,
        startTime: competition.startTime,
        endTime: competition.endTime,
        duration: competition.duration,
        totalPuzzles: competition.puzzles?.length || 0,
        requiresAccessCode: !!competition.accessCode?.trim()
      },
      competitionState,
      participantState,
      leaderboard,
      serverTime: Date.now()
    });

  } catch (err) {
    console.error("Lobby state error:", err);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
};


// Helper function to calculate score
// All puzzles are worth 10 points - winner determined by time taken
const calculateScore = (difficulty, timeSpent) => {
  return 10; // Fixed score for all puzzles
};

// Check for active participation
export const getActiveParticipation = async (req, res) => {
  try {
    const userId = req.user._id;

    // Find participant record where:
    // 1. User is the current user
    // 2. Not submitted yet
    const participations = await ParticipantModel.find({
      userId,
      isSubmitted: false
    }).populate('competitionId');

    // Filter for active/upcoming competitions
    const now = new Date();
    const activeParticipation = participations.find(p => {
      const comp = p.competitionId;
      if (!comp) return false;

      // Allow if LIVE OR UPCOMING (near start)
      // Check status strings case-insensitively
      const status = comp.status?.toUpperCase();

      const isLive = status === 'LIVE';
      const isUpcoming = status === 'UPCOMING';

      // If live, standard check
      if (isLive) {
        return new Date(comp.endTime) > now;
      }

      // If upcoming, always allow rejoining/waiting if within sensible range (or just all joined upcoming)
      // The user wants "popup logic that tournanment is running or about to start"
      if (isUpcoming) {
        return true;
      }

      return false;
    });

    if (activeParticipation) {
      return res.json({
        success: true,
        hasActiveParticipation: true,
        competition: {
          id: activeParticipation.competitionId._id,
          name: activeParticipation.competitionId.name,
          endTime: activeParticipation.competitionId.endTime
        }
      });
    }

    return res.json({
      success: true,
      hasActiveParticipation: false
    });

  } catch (error) {
    console.error('Check active participation error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

export default {
  participateInCompetition,
  submitPuzzleSolution,
  getLiveLeaderboard,
  getCompetitionPuzzles,
  startCompetition,
  submitCompetition,
  getActiveParticipation
};