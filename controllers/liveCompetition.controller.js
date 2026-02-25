import CompetitionModel from "../models/CompetitionSchema.js";
import ParticipantModel from "../models/ParticipantSchema.js";
import PuzzleSolutionModel from "../models/PuzzleSolutionSchema.js";
import PuzzleAttemptModel from "../models/PuzzleAttemptSchema.js";
import PuzzleModel from "../models/PuzzleSchema.js";
import UserModel from "../models/UserSchema.js";
import { io } from "../index.js";
import redis from "../config/redis.js";

import { scheduleCompetitionEnd, getCurrentLeaderboard, handleCompetitionEnd, addParticipantToLeaderboard, getIO, leaderboardKey, redisScore } from "../utils/socketHandlers.js";

// Participate in live competition (REST API validation)
export const participateInCompetition = async (req, res) => {
  try {
    const { competitionId } = req.params;
    const { username, accessCode } = req.body;
    const userId = req.user._id;

    console.log('Participation request:', { competitionId, userId, username });

    // Validate competition exists and is active
    const competition = await CompetitionModel.findById(competitionId);
    if (!competition) {
      return res.status(404).json({
        success: false,
        error: 'Competition not found'
      });
    }

    console.log('Competition found:', competition.name, 'Status:', competition.status);

    // Check if competition is still open for participation (allow joining until competition ends)
    const now = new Date();
    if (now > competition.endTime) {
      return res.status(400).json({
        success: false,
        error: 'Competition has ended'
      });
    }

    if (competition.status === 'ENDED') {
      return res.status(400).json({
        success: false,
        error: 'Competition has ended'
      });
    }

    // Check Access Code if required
    if (competition.accessCode && competition.accessCode.trim() !== '') {
      console.log('Access code required. Competition code:', competition.accessCode, 'Provided code:', accessCode);
      if (!accessCode || accessCode.trim() !== competition.accessCode.trim()) {
        console.log('Access code validation failed');
        return res.status(403).json({
          success: false,
          error: 'Invalid access code',
          requireCode: true
        });
      }
      console.log('Access code validation passed');
    }

    // Check max participants
    const participantCount = await ParticipantModel.countDocuments({ competitionId });
    if (competition.maxParticipants) {
      if (participantCount >= competition.maxParticipants) {
        return res.status(400).json({
          success: false,
          error: 'Competition is full'
        });
      }
    }

    // Check if user already participated
    const existingParticipant = await ParticipantModel.findOne({
      competitionId,
      userId
    });

    if (existingParticipant) {
      // Check if participant has already submitted
      if (existingParticipant.submittedAt) {
        return res.status(400).json({
          success: false,
          message: 'You have already submitted this competition'
        });
      }
    }

    console.log('Existing participant check:', existingParticipant ? 'Found' : 'Not found');

    if (existingParticipant) {
      console.log('User already participated, returning existing data');

      // Ensure they are in Redis (recover from potential sync issues)
      if (competition.status === 'LIVE' || competition.status === 'live') {
        try {
          await addParticipantToLeaderboard(competition._id, existingParticipant);
        } catch (redisErr) {
          console.error('Redis recovery error:', redisErr);
        }
      }

      // Emit participantJoined event so other players see them immediately
      try {
        const roomName = `competition_${competitionId}`;
        io.to(roomName).emit('participantJoined', {
          username: existingParticipant.username,
          userId: existingParticipant.userId.toString(),
        });
        // Also send fresh leaderboard to all
        getCurrentLeaderboard(competitionId).then(leaderboard => {
          io.to(roomName).emit('leaderboardUpdate', leaderboard);
        }).catch(err => console.error('Join leaderboard error:', err));
      } catch (emitErr) {
        console.error('Socket emit on re-join error:', emitErr);
      }

      return res.json({
        success: true,
        message: 'Already participating',
        competition: {
          id: competition._id,
          name: competition.name,
          title: competition.name,
          description: competition.description,
          startTime: competition.startTime,
          endTime: competition.endTime,
          duration: competition.duration,
          status: competition.status,
          participantCount
        }
      });
    }

    // Get user details
    const user = await UserModel.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    console.log('Creating new participant for user:', user.name || user.username);

    // Create participant record
    const participant = new ParticipantModel({
      competitionId,
      userId,
      username: username || user.username || user.name,
      status: "JOINED",
      joinedAt: new Date(),
      score: 0,
      puzzlesSolved: 0,
      timeSpent: 0
    });

    await participant.save();
    console.log('Participant created successfully:', participant._id);

    // Sync with Redis if competition is live
    if (competition.status === 'LIVE' || competition.status === 'live') {
      try {
        await addParticipantToLeaderboard(competition._id, participant);
        console.log('Participant added to Redis leaderboard');
      } catch (redisErr) {
        console.error('Redis sync error:', redisErr);
      }
    }

    // Populate puzzles for response
    await competition.populate('puzzles');

    // Emit participantJoined + leaderboardUpdate for all connected clients
    try {
      const roomName = `competition_${competitionId}`;
      io.to(roomName).emit('participantJoined', {
        username: participant.username,
        userId: participant.userId.toString(),
      });
      getCurrentLeaderboard(competitionId).then(leaderboard => {
        io.to(roomName).emit('leaderboardUpdate', leaderboard);
        console.log('Emitted participantJoined + leaderboardUpdate to room:', roomName);
      }).catch(err => console.error('Join leaderboard error:', err));
    } catch (emitErr) {
      console.error('Socket emit on join error:', emitErr);
    }

    // Return competition details
    res.json({
      success: true,
      competition: {
        id: competition._id,
        name: competition.name,
        title: competition.name,
        description: competition.description,
        startTime: competition.startTime,
        endTime: competition.endTime,
        duration: competition.duration,
        puzzles: competition.puzzles,
        chapters: competition.chapters || [],
        maxScore: competition.puzzles.length * 10,
        status: competition.status,
        participantCount: participantCount + 1
      }
    });

  } catch (error) {
    console.error('Participation error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error during participation'
    });
  }
};

// Submit entire competition (early submission)
export const submitCompetition = async (req, res) => {
  try {
    const { competitionId } = req.params;
    const userId = req.user._id;

    console.log('Competition submission request:', { competitionId, userId });

    // Validate competition exists and is active
    const competition = await CompetitionModel.findById(competitionId);
    if (!competition) {
      return res.status(404).json({
        success: false,
        message: 'Competition not found'
      });
    }

    // Check if competition is live (handle both lowercase and uppercase)
    if (competition.status !== 'live' && competition.status !== 'LIVE') {
      return res.status(400).json({
        success: false,
        message: 'Competition is not currently active'
      });
    }

    // Get participant record
    const participant = await ParticipantModel.findOne({
      competitionId,
      userId
    });

    if (!participant) {
      return res.status(404).json({
        success: false,
        message: 'You are not participating in this competition'
      });
    }

    // Mark participant as submitted (add submittedAt field)
    participant.submittedAt = new Date();
    participant.isActive = false; // Mark as inactive to prevent further submissions
    participant.isSubmitted = true;
    participant.status = "SUBMITTED";
    await participant.save();

    // Notify all participants via Socket.IO
    const roomName = `competition_${competitionId}`;

    // Async leaderboard broadcast
    getCurrentLeaderboard(competitionId).then(updatedLeaderboard => {
      io.to(roomName).emit('leaderboardUpdate', updatedLeaderboard);
    }).catch(err => console.error('Submit leaderboard error:', err));

    io.to(roomName).emit('participantSubmitted', {
      username: participant.username,
      score: participant.score,
      puzzlesSolved: participant.puzzlesSolved,
      timeSpent: participant.timeSpent
    });

    // Check if ALL participants have submitted
    const totalParticipants = await ParticipantModel.countDocuments({ competitionId });
    const submittedParticipants = await ParticipantModel.countDocuments({
      competitionId,
      $or: [{ isSubmitted: true }, { submittedAt: { $exists: true } }]
    });

    console.log(`Competition ${competitionId} progress: ${submittedParticipants}/${totalParticipants} submitted`);

    res.json({
      success: true,
      message: 'Competition submitted successfully',
      finalScore: participant.score,
      puzzlesSolved: participant.puzzlesSolved,
      timeSpent: participant.timeSpent
    });

    // If everyone has submitted, end the competition early
    // We do this AFTER response to avoid blocking, but for UX 'competitionEnded' event will handle redirect
    if (totalParticipants > 0 && submittedParticipants >= totalParticipants) {
      console.log('All participants submitted. Ending competition early.');
      // Use setTimeout to avoid blocking the response
      setTimeout(() => {
        handleCompetitionEnd(io, competitionId);
      }, 100);
    }


  } catch (error) {
    console.error('Competition submission error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error during submission'
    });
  }
};

// Submit puzzle solution with Socket.IO notification
export const submitPuzzleSolution = async (req, res) => {
  try {
    const { competitionId, puzzleId } = req.params;
    const { solution, timeSpent, boardPosition, moveHistory } = req.body;
    const userId = req.user._id;

    /* ================= COMPETITION CHECK ================= */
    const competition = await CompetitionModel.findById(competitionId);
    if (!competition || new Date() > competition.endTime) {
      return res.status(400).json({
        success: false,
        message: "Competition has ended",
      });
    }

    if (competition.status !== "LIVE") {
      return res.status(400).json({
        success: false,
        message: "Competition is not live",
      });
    }

    /* ================= PARTICIPANT CHECK ================= */
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

    /* ================= CHECK FOR EXISTING ATTEMPT ================= */
    const existingAttempt = await PuzzleAttemptModel.findOne({
      competitionId,
      puzzleId,
      userId,
    });

    // If puzzle is already completed (solved or failed), prevent new attempts
    if (existingAttempt && (existingAttempt.status === 'solved' || existingAttempt.status === 'failed')) {
      return res.status(400).json({
        success: false,
        message: `Puzzle already ${existingAttempt.status}`,
        puzzleStatus: existingAttempt.status
      });
    }

    /* ================= PUZZLE CHECK ================= */
    const puzzle = await PuzzleModel.findById(puzzleId);
    if (!puzzle) {
      return res.status(404).json({
        success: false,
        message: "Puzzle not found",
      });
    }

    const isCorrect = validatePuzzleSolution(puzzle, solution);

    /* ================= MARK PLAYER AS PLAYING ================= */
    if (participant.status === "JOINED") {
      participant.status = "PLAYING";
      await participant.save();

      // Notify lobby immediately
      io.to(`competition_${competitionId}`).emit("player-progress", {
        userId,
        participantState: "PLAYING",
      });
    }

    /* ================= HANDLE SOLUTION RESULT ================= */
    if (isCorrect) {
      // CORRECT SOLUTION
      const scoreEarned = calculateScore(puzzle.difficulty, timeSpent);

      // Create or update puzzle attempt
      const puzzleAttempt = await PuzzleAttemptModel.findOneAndUpdate(
        { competitionId, puzzleId, userId },
        {
          status: 'solved',
          solution,
          boardPosition,
          moveHistory: moveHistory || [],
          timeSpent,
          scoreEarned,
          isLocked: true,
          completedAt: new Date()
        },
        { upsert: true, new: true }
      );

      console.log('Created/updated puzzle attempt (solved):', {
        puzzleId,
        userId,
        status: puzzleAttempt.status,
        isLocked: puzzleAttempt.isLocked
      });

      // Create puzzle solution record (for backward compatibility)
      const puzzleSolution = new PuzzleSolutionModel({
        competitionId,
        puzzleId,
        userId,
        solution,
        timeSpent,
        scoreEarned,
        isCorrect: true,
        solvedAt: new Date(),
      });

      await puzzleSolution.save();

      // Update participant score
      const updatedParticipant = await ParticipantModel.findOneAndUpdate(
        { competitionId, userId },
        {
          $inc: {
            score: scoreEarned,
            puzzlesSolved: 1,
            timeSpent: timeSpent,
          },
          lastActivity: new Date(),
        },
        { new: true }
      );

      /* ================= UPDATE REDIS + BROADCAST ================= */
      // Sync Redis sorted set with fresh score BEFORE reading leaderboard
      try {
        await redis.zadd(
          leaderboardKey(competitionId),
          redisScore(updatedParticipant),
          userId.toString()
        );
      } catch (redisError) {
        console.error(`[Leaderboard] Redis zadd error in submit:`, redisError);
      }

      // Broadcast leaderboard updates asynchronously
      getCurrentLeaderboard(competitionId).then(leaderboard => {
        io.to(`competition_${competitionId}`).emit("leaderboardUpdate", leaderboard);
      }).catch(err => console.error('Puzzle solve leaderboard error:', err));

      // Emit live score update for immediate feedback in lobby
      io.to(`competition_${competitionId}`).emit("liveScoreUpdate", {
        userId: updatedParticipant.userId,
        username: updatedParticipant.username,
        score: updatedParticipant.score,
        puzzlesSolved: updatedParticipant.puzzlesSolved,
        timeSpent: updatedParticipant.timeSpent,
        status: updatedParticipant.status
      });

      /* ================= SUCCESS RESPONSE ================= */
      res.json({
        success: true,
        isCorrect: true,
        scoreEarned,
        totalScore: updatedParticipant.score,
        puzzlesSolved: updatedParticipant.puzzlesSolved,
        puzzleStatus: 'solved',
        message: "Puzzle solved successfully!",
      });

    } else {
      // INCORRECT SOLUTION
      // Create or update puzzle attempt as failed
      const puzzleAttempt = await PuzzleAttemptModel.findOneAndUpdate(
        { competitionId, puzzleId, userId },
        {
          status: 'failed',
          solution,
          boardPosition,
          moveHistory: moveHistory || [],
          timeSpent,
          scoreEarned: 0,
          isLocked: true,
          completedAt: new Date()
        },
        { upsert: true, new: true }
      );

      console.log('Created/updated puzzle attempt (failed):', {
        puzzleId,
        userId,
        status: puzzleAttempt.status,
        isLocked: puzzleAttempt.isLocked
      });

      // Update participant time spent (but no score)
      const updatedParticipant = await ParticipantModel.findOneAndUpdate(
        { competitionId, userId },
        {
          $inc: {
            timeSpent: timeSpent,
          },
          lastActivity: new Date(),
        },
        { new: true }
      );

      /* ================= FAILURE RESPONSE ================= */
      res.json({
        success: false,
        isCorrect: false,
        scoreEarned: 0,
        totalScore: updatedParticipant.score,
        puzzlesSolved: updatedParticipant.puzzlesSolved,
        puzzleStatus: 'failed',
        message: "Incorrect solution. .",
      });
    }

  } catch (error) {
    console.error("Puzzle submission error:", error);
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

    // Validate competition exists
    const competition = await CompetitionModel.findById(competitionId);
    if (!competition) {
      return res.status(404).json({
        success: false,
        message: 'Competition not found'
      });
    }

    // Get current leaderboard
    const leaderboard = await getCurrentLeaderboard(competitionId);
    const participant = await ParticipantModel.findOne({
      competitionId,
      userId: req.user?._id
    });

    let participantState = "NOT_JOINED";
    if (participant) {
      participantState = participant.status;
    }

    res.json({
      success: true,
      competition: {
        id: competition._id,
        name: competition.name,
        status: competition.status,
        startTime: competition.startTime,
        endTime: competition.endTime
      },
      competitionState: competition.status, // UPCOMING | LIVE | ENDED
      participantState,                     // NOT_JOINED | JOINED | PLAYING | SUBMITTED
      leaderboard,
      serverTime: Date.now()
    });

  } catch (error) {
    console.error('Error fetching live leaderboard:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch leaderboard'
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
        kidsConfig: puzzle.kidsConfig,
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

    // 1. Competition lao with puzzles populated
    const competition = await CompetitionModel.findById(competitionId).populate('puzzles');
    if (!competition) {
      return res.status(404).json({ success: false, message: "Competition not found" });
    }

    // 2. Participant lao (sirf ParticipantModel se)
    const participant = await ParticipantModel.findOne({
      competitionId,
      userId
    });

    // 3. Competition state - check time-based status
    const now = new Date();
    let competitionState = competition.status ? competition.status.toUpperCase() : "UPCOMING";

    // Update status based on current time if needed
    if (competitionState === "UPCOMING" && now >= competition.startTime && now <= competition.endTime) {
      competitionState = "LIVE";
      // Update in DB if needed
      if (competition.status !== "LIVE") {
        competition.status = "LIVE";
        competition.isActive = true;
        await competition.save();
      }
    } else if (now > competition.endTime) {
      competitionState = "ENDED";
      if (competition.status !== "ENDED") {
        competition.status = "ENDED";
        competition.isActive = false;
        await competition.save();
      }
    }

    // 4. Participant state
    let participantState = "NOT_JOINED";
    if (participant) {
      participantState = participant.status || "JOINED";
      // JOINED | PLAYING | SUBMITTED
    }

    // 5. Leaderboard lao
    const leaderboard = await getCurrentLeaderboard(competitionId);

    // 6. Response bhejo with total puzzle count
    res.json({
      success: true,
      competition: {
        id: competition._id,
        name: competition.name,
        startTime: competition.startTime,
        endTime: competition.endTime,
        duration: competition.duration,
        totalPuzzles: Array.isArray(competition.puzzles) ? competition.puzzles.length : 0, // Add total puzzle count
        requiresAccessCode: !!(competition.accessCode && competition.accessCode.trim() !== '')
      },
      competitionState,
      participantState,
      leaderboard,
      serverTime: Date.now()
    });

  } catch (err) {
    console.error("Lobby state error:", err);
    res.status(500).json({ success: false, message: "Server error" });
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