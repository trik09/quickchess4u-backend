import CompetitionModel from "../models/CompetitionSchema.js";
import ParticipantModel from "../models/ParticipantSchema.js";
import { handleCompetitionEnd } from "./socketHandlers.js";

class CompetitionManager {
    constructor(io) {
        this.io = io;
        this.checkInterval = 10 * 1000; // Check every 10 seconds
        this.isRunning = false;
    }

    // Start the monitoring loop
    startMonitoring() {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log("Competition Manager: Started monitoring loop");

        // Initial check
        this.checkCompetitions();

        // Loop
        setInterval(() => this.checkCompetitions(), this.checkInterval);
    }

    async checkCompetitions() {
        try {
            const now = new Date();

            // 1. Find UPCOMING competitions that should START
            // startTime matches or is in the past, and status is still upcoming
            const competitionsToStart = await CompetitionModel.find({
                status: "upcoming",
                startTime: { $lte: now }
            });

            for (const competition of competitionsToStart) {
                await this.startCompetition(competition);
            }

            // 2. Find LIVE competitions that should END
            // endTime matches or is in the past, and status is live
            const competitionsToEnd = await CompetitionModel.find({
                status: "live",
                endTime: { $lte: now }
            });

            for (const competition of competitionsToEnd) {
                await this.endCompetition(competition);
            }

        } catch (error) {
            console.error("Competition Manager Error:", error);
        }
    }

    async startCompetition(competition) {
        try {
            console.log(`Starting competition: ${competition.name} (${competition._id})`);

            competition.status = "live";
            competition.isActive = true;
            await competition.save();

            // Notify all participants in the lobby
            this.io.to(`competition_${competition._id}`).emit("competitionStarted", {
                competitionId: competition._id,
                startTime: competition.startTime,
                endTime: competition.endTime
            });

            // Update participants status to 'playing'
            await ParticipantModel.updateMany(
                { competitionId: competition._id, status: "waiting" },
                { status: "playing" }
            );

        } catch (error) {
            console.error(`Failed to start competition ${competition._id}:`, error);
        }
    }

    async endCompetition(competition) {
        try {
            console.log(`Ending competition: ${competition.name} (${competition._id})`);

            // Use the existing logic in socketHandlers which handles ranking and notification
            await handleCompetitionEnd(this.io, competition._id);

        } catch (error) {
            console.error(`Failed to end competition ${competition._id}:`, error);
        }
    }
}

let competitionManagerInstance = null;

export const initializeCompetitionManager = (io) => {
    if (!competitionManagerInstance) {
        competitionManagerInstance = new CompetitionManager(io);
        competitionManagerInstance.startMonitoring();
    }
    return competitionManagerInstance;
};
