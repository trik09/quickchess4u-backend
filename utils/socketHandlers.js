// ==================== Redis Implementation (Refactored) ====================

import jwt from "jsonwebtoken";
import redis from "../config/redis.js";
import CompetitionModel from "../models/CompetitionSchema.js";
import ParticipantModel from "../models/ParticipantSchema.js";
import CompetitionRankingModel from "../models/CompetitionRankingSchema.js";

/* =========================================================
   MODULE STATE
========================================================= */
let _io = null;
const getIO = () => _io;

/* =========================================================
   REDIS KEY HELPERS
========================================================= */
const leaderboardKey = (competitionId) => `leaderboard:${competitionId}`;
const leaderboardMetaKey = (competitionId) => `leaderboard:meta:${competitionId}`;

/* =========================================================
   SCORE FORMULA
   Higher puzzlesSolved → higher rank
   Lower timeSpent     → higher rank (within same puzzlesSolved)
   score               → tiebreaker
========================================================= */
const redisScore = (p) =>
  p.puzzlesSolved * 1_000_000 -
  p.timeSpent * 1_000 +
  (p.score || 0);

/* =========================================================
   CORE REDIS UPSERT
   Member = plain userId string  →  ZADD is always an UPDATE,
   never an INSERT of a duplicate.  Metadata lives in a Hash.
========================================================= */
const upsertLeaderboardEntry = async (competitionId, participant) => {
  const userId =
    participant.userId?._id?.toString() ||
    participant.userId?.toString();

  if (!userId) return;

  try {
    const pipeline = redis.pipeline();

    // Sorted-set: member = userId  (unique → no duplicates ever)
    pipeline.zadd(
      leaderboardKey(competitionId),
      redisScore(participant),
      userId
    );

    // Hash: full metadata keyed by userId
    pipeline.hset(
      leaderboardMetaKey(competitionId),
      userId,
      JSON.stringify({
        userId,
        username: participant.username || null,
        name: participant.name ||
          participant.userId?.name || null,
        avatar: participant.avatar ||
          participant.userId?.avatar || null,
        score: participant.score || 0,
        puzzlesSolved: participant.puzzlesSolved || 0,
        timeSpent: participant.timeSpent || 0,
        status: participant.status || "JOINED",
        submittedAt: participant.submittedAt || null,
      })
    );

    await pipeline.exec();
  } catch (error) {
    console.error(
      `[Leaderboard] upsertLeaderboardEntry error for ${competitionId}:`,
      error
    );
  }
};

/* =========================================================
   BUILD LEADERBOARD IN REDIS  (on start / server restart)
========================================================= */
const buildRedisLeaderboard = async (competitionId) => {
  try {
    const participants = await ParticipantModel.find({ competitionId })
      .select("userId username score puzzlesSolved timeSpent status submittedAt")
      .populate("userId", "name avatar")
      .lean();

    if (!participants.length) return;

    const pipeline = redis.pipeline();
    const key = leaderboardKey(competitionId);
    const metaKey = leaderboardMetaKey(competitionId);

    for (const p of participants) {
      if (!p.userId) continue;
      const userId = p.userId._id.toString();

      pipeline.zadd(key, redisScore(p), userId);

      pipeline.hset(
        metaKey,
        userId,
        JSON.stringify({
          userId,
          username: p.username,
          name: p.userId.name,
          avatar: p.userId.avatar,
          score: p.score || 0,
          puzzlesSolved: p.puzzlesSolved || 0,
          timeSpent: p.timeSpent || 0,
          status: p.status || "JOINED",
          submittedAt: p.submittedAt || null,
        })
      );
    }

    await pipeline.exec();
    console.log(`🔥 Redis leaderboard built for ${competitionId}`);
  } catch (error) {
    console.error(
      `[Leaderboard] Redis build error for ${competitionId}:`,
      error
    );
  }
};

/* =========================================================
   GET LEADERBOARD  (Redis → DB merge, with DB fallback)
========================================================= */
const getCurrentLeaderboard = async (competitionId, limit = 200) => {
  const key = leaderboardKey(competitionId);
  const metaKey = leaderboardMetaKey(competitionId);

  try {
    // 1. Get ordered userId list from sorted set
    const userIds = await redis.zrevrange(key, 0, limit - 1);

    if (userIds?.length) {
      // 2. Fetch all metadata in one round-trip
      const pipeline = redis.pipeline();
      userIds.forEach((uid) => pipeline.hget(metaKey, uid));
      const metaResults = await pipeline.exec();

      // 3. Fetch fresh status/scores from DB (source of truth for status)
      const dbParticipants = await ParticipantModel.find({
        competitionId,
        userId: { $in: userIds },
      })
        .select("userId username score puzzlesSolved timeSpent status submittedAt")
        .populate("userId", "name avatar")
        .lean();

      const dbMap = new Map();
      dbParticipants.forEach((p) => {
        if (p.userId) dbMap.set(p.userId._id.toString(), p);
      });

      // 4. Merge Redis metadata + fresh DB data
      return userIds
        .map((uid, index) => {
          const metaRaw = metaResults[index]?.[1];
          const meta = metaRaw ? JSON.parse(metaRaw) : null;
          const db = dbMap.get(uid);

          return {
            rank: index + 1,
            userId: uid,
            username: db?.username ?? meta?.username ?? null,
            name: db?.userId?.name ?? meta?.name ?? null,
            avatar: db?.userId?.avatar ?? meta?.avatar ?? null,
            score: db?.score ?? meta?.score ?? 0,
            puzzlesSolved: db?.puzzlesSolved ?? meta?.puzzlesSolved ?? 0,
            timeSpent: db?.timeSpent ?? meta?.timeSpent ?? 0,
            // Always prefer fresh DB values for status & submittedAt
            status: db?.status ?? meta?.status ?? "JOINED",
            submittedAt: db?.submittedAt ?? meta?.submittedAt ?? null,
          };
        })
        .filter(Boolean);
    }
  } catch (error) {
    console.error(`[Leaderboard] Redis read error for ${competitionId}:`, error);
  }

  // ── DB fallback (Redis miss / error) ──────────────────────────────────────
  console.warn(`[Leaderboard] Falling back to DB for ${competitionId}`);

  const participants = await ParticipantModel.find({ competitionId })
    .select("userId username score puzzlesSolved timeSpent status submittedAt")
    .sort({ puzzlesSolved: -1, timeSpent: 1, score: -1 })
    .limit(limit)
    .populate("userId", "name avatar")
    .lean();

  if (!participants.length) return [];

  const leaderboard = participants.map((p, index) => ({
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

  // Rebuild Redis in the background so next call is fast
  setImmediate(async () => {
    try {
      const exists = await redis.exists(key);
      if (exists) return;
      await buildRedisLeaderboard(competitionId);
    } catch (err) {
      console.error("[Leaderboard] Redis rebuild error:", err);
    }
  });

  return leaderboard;
};

/* =========================================================
   SOCKET AUTH MIDDLEWARE
========================================================= */
const authenticateSocket = (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) throw new Error("No token");

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = decoded.id;
    next();
  } catch {
    next(new Error("Authentication failed"));
  }
};

/* =========================================================
   AUTO-START COMPETITION
========================================================= */
const autoStartCompetition = async (io, competition) => {
  const now = new Date();
  if (competition.status !== "UPCOMING") return;
  if (now < competition.startTime) return;

  competition.status = "LIVE";
  competition.isActive = true;
  await competition.save();

  // Emit immediately — don't wait for Redis
  io.to(`competition_${competition._id}`).emit("competitionStarted");
  scheduleCompetitionEnd(io, competition._id, competition.endTime);

  // Build Redis in background
  setImmediate(async () => {
    try {
      const exists = await redis.exists(leaderboardKey(competition._id));
      if (!exists) await buildRedisLeaderboard(competition._id);
    } catch (err) {
      console.error("[Leaderboard] Redis build error after start:", err);
    }
  });
};

/* =========================================================
   COMPETITION END HANDLER
========================================================= */
const handleCompetitionEnd = async (io, competitionId) => {
  const leaderboard = await getCurrentLeaderboard(competitionId);
  io.to(`competition_${competitionId}`).emit("competitionEnded", {
    leaderboard,
    message: "Competition ended! Calculating final results...",
  });

  // All heavy work happens in background AFTER the emit
  (async () => {
    try {
      await CompetitionModel.findByIdAndUpdate(competitionId, {
        status: "ENDED",
        isActive: false,
        updatedAt: new Date(),
      });

      // Always use DB for final rankings — Redis may miss 0-score users
      const allParticipants = await ParticipantModel.find({ competitionId })
        .select("userId username score puzzlesSolved timeSpent status submittedAt")
        .sort({ puzzlesSolved: -1, timeSpent: 1, score: -1 })
        .populate("userId", "name avatar")
        .lean();

      const finalLeaderboard = allParticipants.map((p, index) => ({
        rank: index + 1,
        userId: p.userId?._id?.toString(),
        username: p.username,
        score: p.score || 0,
        puzzlesSolved: p.puzzlesSolved || 0,
        timeSpent: p.timeSpent || 0,
        status: p.status,
        submittedAt: p.submittedAt,
      }));

      await CompetitionRankingModel.deleteMany({ competitionId });

      if (finalLeaderboard.length) {
        await CompetitionRankingModel.insertMany(
          finalLeaderboard.map((p) => ({
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

      // Clean up BOTH Redis keys — delay 5 minutes so the leaderboard
      // page can still read from Redis immediately after competition ends.
      setTimeout(async () => {
        try {
          const pipeline = redis.pipeline();
          pipeline.del(leaderboardKey(competitionId));
          pipeline.del(leaderboardMetaKey(competitionId));
          await pipeline.exec();
          console.log(`🧹 Redis leaderboard cleaned up for ${competitionId}`);
        } catch (err) {
          console.error("[Leaderboard] Redis cleanup error:", err);
        }
      }, 5 * 60 * 1000);

      console.log(
        `✅ Competition ${competitionId} final results saved.`
      );
    } catch (err) {
      console.error(
        `[Leaderboard] Error saving final results for ${competitionId}:`,
        err
      );
    }
  })();
};

/* =========================================================
   SCHEDULE COMPETITION END
========================================================= */
const scheduleCompetitionEnd = (io, competitionId, endTime) => {
  const delay = endTime.getTime() - Date.now();
  if (delay <= 0) return;

  setTimeout(() => {
    handleCompetitionEnd(io, competitionId);
  }, delay);
};

/* =========================================================
   SOCKET INITIALIZER
========================================================= */
export const initializeSocketHandlers = (io) => {
  _io = io;
  io.use(authenticateSocket);

  io.on("connection", (socket) => {
    console.log("🔌 Connected:", socket.userId);

    /* ── JOIN ── */
    socket.on("joinCompetition", async ({ competitionId }) => {
      try {
        socket.join(`competition_${competitionId}`);

        const leaderboard = await getCurrentLeaderboard(competitionId);

        socket.emit("competitionJoined", {
          serverTime: Date.now(),
          leaderboard,
        });
      } catch (err) {
        console.error("[Socket] joinCompetition error:", err);
      }
    });

    /* ── SUBMIT ── */
    socket.on("submitCompetition", async ({ competitionId }) => {
      try {
        const participant = await ParticipantModel.findOneAndUpdate(
          { competitionId, userId: socket.userId },
          { status: "SUBMITTED", submittedAt: new Date() },
          { new: true }
        ).populate("userId", "name avatar");

        if (!participant) return;

        // Upsert into Redis using the fixed helper (no duplicates)
        await upsertLeaderboardEntry(competitionId, {
          userId: participant.userId._id.toString(),
          username: participant.username,
          name: participant.userId.name,
          avatar: participant.userId.avatar,
          score: participant.score,
          puzzlesSolved: participant.puzzlesSolved,
          timeSpent: participant.timeSpent,
          status: "SUBMITTED",
          submittedAt: participant.submittedAt,
        });

        const leaderboard = await getCurrentLeaderboard(competitionId);
        io.to(`competition_${competitionId}`).emit("leaderboardUpdate", leaderboard);
      } catch (err) {
        console.error("[Socket] submitCompetition error:", err);
      }
    });

    /* ── REFRESH LEADERBOARD ── */
    socket.on("refreshLeaderboard", async ({ competitionId }) => {
      try {
        if (!competitionId) return;
        const leaderboard = await getCurrentLeaderboard(competitionId);
        socket.emit("leaderboardUpdate", leaderboard);
      } catch (err) {
        console.error("[Socket] refreshLeaderboard error:", err);
      }
    });

    /* ── DISCONNECT ── */
    socket.on("disconnect", () => {
      console.log("❌ Disconnected:", socket.userId);
    });
  });

  /* =========================================================
     SERVER RESTART RECOVERY
  ========================================================= */
  const recover = async () => {
    try {
      const competitions = await CompetitionModel.find({
        endTime: { $gt: new Date() },
      });

      for (const comp of competitions) {
        if (comp.status === "LIVE") {
          const exists = await redis.exists(leaderboardKey(comp._id));
          if (!exists) await buildRedisLeaderboard(comp._id);
          scheduleCompetitionEnd(io, comp._id, comp.endTime);
        }

        if (comp.status === "UPCOMING") {
          setImmediate(async () => {
            try {
              const exists = await redis.exists(leaderboardKey(comp._id));
              if (!exists) await buildRedisLeaderboard(comp._id);
            } catch (err) {
              console.error(
                `[Leaderboard] Redis pre-build error for upcoming ${comp._id}:`,
                err
              );
            }
          });
          await autoStartCompetition(io, comp);
        }
      }

      console.log(`♻️  Recovered ${competitions.length} competitions`);
    } catch (err) {
      console.error("[Socket] Recovery error:", err);
    }
  };

  recover();

  // Poll for UPCOMING competitions that should have started
  setInterval(async () => {
    try {
      const comps = await CompetitionModel.find({
        status: "UPCOMING",
        startTime: { $lte: new Date() },
        endTime: { $gt: new Date() },
      });
      for (const c of comps) await autoStartCompetition(io, c);
    } catch (err) {
      console.error("[Socket] Auto-start poll error:", err);
    }
  }, 10_000);
};

/* =========================================================
   ADD PARTICIPANT TO LEADERBOARD  (called from join route)
========================================================= */
export const addParticipantToLeaderboard = async (
  competitionId,
  participant
) => {
  if (!participant?.userId) return;

  // Use the fixed upsert — safe against duplicates
  await upsertLeaderboardEntry(competitionId, participant);

  // Broadcast updated leaderboard
  if (_io) {
    try {
      const leaderboard = await getCurrentLeaderboard(competitionId);
      _io
        .to(`competition_${competitionId}`)
        .emit("leaderboardUpdate", leaderboard);
    } catch (err) {
      console.error(
        "[Leaderboard] addParticipantToLeaderboard broadcast error:",
        err
      );
    }
  }
};

/* =========================================================
   UPDATE PARTICIPANT SCORE  (call this from your solve route
   instead of doing a raw redis.zadd elsewhere)
========================================================= */
export const updateParticipantScore = async (competitionId, userId) => {
  try {
    const participant = await ParticipantModel.findOne({
      competitionId,
      userId,
    })
      .select("userId username score puzzlesSolved timeSpent status submittedAt")
      .populate("userId", "name avatar")
      .lean();

    if (!participant) return;

    await upsertLeaderboardEntry(competitionId, {
      userId: participant.userId._id.toString(),
      username: participant.username,
      name: participant.userId.name,
      avatar: participant.userId.avatar,
      score: participant.score,
      puzzlesSolved: participant.puzzlesSolved,
      timeSpent: participant.timeSpent,
      status: participant.status,
      submittedAt: participant.submittedAt,
    });

    // Broadcast updated leaderboard
    if (_io) {
      const leaderboard = await getCurrentLeaderboard(competitionId);
      _io
        .to(`competition_${competitionId}`)
        .emit("leaderboardUpdate", leaderboard);
    }
  } catch (error) {
    console.error(
      `[Leaderboard] updateParticipantScore error for ${competitionId}:`,
      error
    );
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
  leaderboardMetaKey,
  redisScore,
  upsertLeaderboardEntry,
};