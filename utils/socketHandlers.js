import jwt from "jsonwebtoken";
import redis from "../config/redis.js";
import CompetitionModel from "../models/CompetitionSchema.js";
import ParticipantModel from "../models/ParticipantSchema.js";
import CompetitionRankingModel from "../models/CompetitionRankingSchema.js";

/* =========================================================
   MODULE STATE
========================================================= */
let _io = null; // Store io reference for use in exported helpers

const getIO = () => _io;

/* =========================================================
   REDIS HELPERS
========================================================= */
const leaderboardKey = (competitionId) =>
  `leaderboard:${competitionId}`;

const redisScore = (p) =>
  p.puzzlesSolved * 1_000_000 -
  p.timeSpent * 1000 +
  p.score;

/* =========================================================
   BUILD LEADERBOARD IN REDIS (ON START / RESTART)
========================================================= */
const buildRedisLeaderboard = async (competitionId) => {
  try {
    const participants = await ParticipantModel.find({ competitionId }).lean();
    if (!participants.length) return;

    const pipeline = redis.pipeline();

    for (const p of participants) {
      if (p.userId) {
        pipeline.zadd(
          leaderboardKey(competitionId),
          redisScore(p),
          p.userId.toString()
        );
      }
    }

    await pipeline.exec();
  } catch (error) {
    console.error(`[Leaderboard] Redis build error for ${competitionId}:`, error);
  }
};

/* =========================================================
   GET LEADERBOARD (REDIS → DB MAP)
========================================================= */
const getCurrentLeaderboard = async (competitionId, limit = 100) => {
  let userIds = [];

  try {
    userIds = await redis.zrevrange(
      leaderboardKey(competitionId),
      0,
      limit - 1
    );
  } catch (error) {
    console.error(`[Leaderboard] Redis error for ${competitionId}:`, error);
  }

  // DB fallback
  if (!userIds?.length) {
    const participants = await ParticipantModel.find({ competitionId })
      .select("userId username score puzzlesSolved timeSpent status submittedAt")
      .sort({ puzzlesSolved: -1, timeSpent: 1, score: -1 })
      .limit(limit)
      .populate("userId", "name avatar")
      .lean();

    if (!participants.length) return [];

    // rebuild redis asynchronously
    setImmediate(async () => {
      try {
        const pipeline = redis.pipeline();

        participants.forEach((p) => {
          if (p.userId?._id) {
            pipeline.zadd(
              leaderboardKey(competitionId),
              redisScore(p),
              p.userId._id.toString()
            );
          }
        });

        await pipeline.exec();
      } catch (err) {
        console.error("Redis rebuild error:", err);
      }
    });

    return participants.map((p, index) => ({
      rank: index + 1,
      userId: p.userId?._id?.toString(),
      username: p.username,
      name: p.userId?.name,
      avatar: p.userId?.avatar,
      score: p.score || 0,
      puzzlesSolved: p.puzzlesSolved || 0,
      timeSpent: p.timeSpent || 0,
      status: p.status,
      submittedAt: p.submittedAt,
    }));
  }

  const participants = await ParticipantModel.find({
    competitionId,
    userId: { $in: userIds },
  })
    .select("userId username score puzzlesSolved timeSpent status submittedAt")
    .populate("userId", "name avatar")
    .lean();

  const map = new Map();

  participants.forEach((p) => {
    if (p.userId) {
      const uid = p.userId._id.toString();
      map.set(uid, p);
    }
  });

  return userIds
    .map((id, index) => {
      const p = map.get(id);
      if (!p) return null;

      return {
        rank: index + 1,
        userId: id,
        username: p.username,
        name: p.userId?.name,
        avatar: p.userId?.avatar,
        score: p.score,
        puzzlesSolved: p.puzzlesSolved,
        timeSpent: p.timeSpent,
        status: p.status,
        submittedAt: p.submittedAt,
      };
    })
    .filter(Boolean);
};

/* =========================================================
   SOCKET AUTH
========================================================= */
const authenticateSocket = (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) throw new Error();

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = decoded.id;
    next();
  } catch {
    next(new Error("Authentication failed"));
  }
};

/* =========================================================
   AUTO START COMPETITION
========================================================= */
const autoStartCompetition = async (io, competition) => {
  const now = new Date();
  if (competition.status !== "UPCOMING") return;
  if (now < competition.startTime) return;

  competition.status = "LIVE";
  competition.isActive = true;
  await competition.save();

  await buildRedisLeaderboard(competition._id);

  io.to(`competition_${competition._id}`).emit("competitionStarted");

  scheduleCompetitionEnd(io, competition._id, competition.endTime);
};

/* =========================================================
   AUTO END COMPETITION
========================================================= */
const handleCompetitionEnd = async (io, competitionId) => {
  // Get final leaderboard fast from Redis/DB
  const leaderboard = await getCurrentLeaderboard(competitionId);

  // 1. Emit immediately to frontend so players see it instantly without 5-6s delay!
  io.to(`competition_${competitionId}`).emit("competitionEnded", {
    leaderboard,
    message: "Competition ended! Calculating final results...",
  });

  // 2. Perform heavy DB updates in the background (fire and forget)
  (async () => {
    try {
      await CompetitionModel.findByIdAndUpdate(competitionId, {
        status: "ENDED",
        isActive: false,
        updatedAt: new Date(),
      });

      await CompetitionRankingModel.deleteMany({ competitionId });

      if (leaderboard.length) {
        await CompetitionRankingModel.insertMany(
          leaderboard.map((p) => ({
            competitionId,
            userId: p.userId,
            username: p.username,
            finalRank: p.rank,
            finalScore: p.score,
            puzzlesSolved: p.puzzlesSolved,
            totalTime: p.timeSpent,
            ENDEDAt: new Date(),
          }))
        );
      }

      try {
        await redis.del(leaderboardKey(competitionId));
      } catch (error) {
        console.error(`[Leaderboard] Redis del error for ${competitionId}:`, error);
      }

      console.log(`Competition ${competitionId} final results saved and cleaned up.`);
    } catch (err) {
      console.error(`Error saving final results for ${competitionId}:`, err);
    }
  })();
};

/* =========================================================
   SCHEDULE END
========================================================= */
const scheduleCompetitionEnd = (io, competitionId, endTime) => {
  const delay = endTime.getTime() - Date.now();
  if (delay <= 0) return;

  setTimeout(() => {
    handleCompetitionEnd(io, competitionId);
  }, delay);
};

const formatLeaderboardFromRedis = (redisData) => {
  const result = [];

  for (let i = 0; i < redisData.length; i += 2) {
    result.push({
      rank: i / 2 + 1,
      userId: redisData[i],
      score: Number(redisData[i + 1]),
    });
  }

  return result;
};
/* =========================================================
   SOCKET INITIALIZER
========================================================= */
export const initializeSocketHandlers = (io) => {
  _io = io; // Store for use in exported helpers
  io.use(authenticateSocket);

  io.on("connection", (socket) => {
    console.log("🔌 Connected:", socket.userId);

    /* ---------- JOIN ---------- */
    socket.on("joinCompetition", async ({ competitionId }) => {
      try {
        socket.join(`competition_${competitionId}`);

        // Get leaderboard directly from Redis
        const leaderboard = await redis.zrevrange(
          leaderboardKey(competitionId),
          0,
          49,
          "WITHSCORES"
        );

        const formatted = formatLeaderboardFromRedis(leaderboard);

        socket.emit("competitionJoined", {
          serverTime: Date.now(),
          leaderboard: formatted,
        });

      } catch (err) {
        console.error("joinCompetition:", err);
      }
    });

    /* ---------- SUBMIT ---------- */
    socket.on("submitCompetition", async ({ competitionId }) => {
      try {
        const participant = await ParticipantModel.findOneAndUpdate(
          { competitionId, userId: socket.userId },
          {
            status: "SUBMITTED",
            submittedAt: new Date(),
          },
          { new: true }
        );

        try {
          await redis.zadd(
            leaderboardKey(competitionId),
            redisScore(participant),
            participant.userId.toString()
          );
        } catch (error) {
          console.error(`[Leaderboard] Redis zadd error for ${competitionId} on submitCompetition socket:`, error);
        }

        const leaderboard = await getCurrentLeaderboard(competitionId);
        io.to(`competition_${competitionId}`).emit(
          "leaderboardUpdate",
          leaderboard
        );
      } catch (err) {
        console.error("submitCompetition:", err);
      }
    });

    /* ---------- REFRESH LEADERBOARD ---------- */
    socket.on("refreshLeaderboard", async ({ competitionId }) => {
      try {
        if (!competitionId) return;
        const leaderboard = await getCurrentLeaderboard(competitionId);
        socket.emit("leaderboardUpdate", leaderboard);
      } catch (err) {
        console.error("refreshLeaderboard:", err);
      }
    });

    socket.on("disconnect", () => {
      console.log("❌ Disconnected:", socket.userId);
    });
  });

  /* =========================================================
     SERVER RESTART RECOVERY
  ========================================================= */
  const recover = async () => {
    const competitions = await CompetitionModel.find({
      endTime: { $gt: new Date() },
    });

    for (const comp of competitions) {
      if (comp.status === "LIVE") {
        await buildRedisLeaderboard(comp._id);
        scheduleCompetitionEnd(io, comp._id, comp.endTime);
      }

      if (comp.status === "UPCOMING") {
        autoStartCompetition(io, comp);
      }
    }

    console.log(`♻️ Recovered ${competitions.length} competitions`);
  };

  recover();

  setInterval(async () => {
    const comps = await CompetitionModel.find({
      status: "UPCOMING",
      startTime: { $lte: new Date() },
      endTime: { $gt: new Date() },
    });

    for (const c of comps) {
      await autoStartCompetition(io, c);
    }
  }, 10000);
};

/* =========================================================
   ADD PARTICIPANT TO LEADERBOARD
========================================================= */
export const addParticipantToLeaderboard = async (competitionId, participant) => {
  try {
    if (participant && participant.userId) {
      await redis.zadd(
        leaderboardKey(competitionId),
        redisScore(participant),
        participant.userId.toString()
      );
    }
  } catch (error) {
    console.error(`[Leaderboard] Redis add error for ${competitionId}:`, error);
  }

  // Broadcast updated leaderboard to all clients in the room
  if (_io) {
    try {
      const leaderboard = await getCurrentLeaderboard(competitionId);
      _io.to(`competition_${competitionId}`).emit("leaderboardUpdate", leaderboard);
    } catch (err) {
      console.error("addParticipantToLeaderboard broadcast error:", err);
    }
  }
};

/* =========================================================
   EXPORTS
========================================================= */
export {
  getCurrentLeaderboard,
  handleCompetitionEnd,
  scheduleCompetitionEnd,
  getIO,
  leaderboardKey,
  redisScore,
};

