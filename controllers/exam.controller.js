import ExamModel from "../models/ExamSchema.js";
import QuizModel from "../models/QuizSchema.js";

// -- ADMIN CONTROLLERS --

export const createExam = async (req, res) => {
  try {
    const { name, description, startTime, endTime, duration, chapters, isActive } = req.body;

    if (!name || !startTime || !endTime) {
      return res.status(400).json({ message: "Name, startTime, and endTime are required" });
    }

    const start = new Date(startTime);
    const end = new Date(endTime);
    let status = "UPCOMING";
    const now = new Date();

    if (now >= start && now <= end) status = "LIVE";
    else if (now > end) status = "ENDED";

    const exam = await ExamModel.create({
      name,
      description,
      startTime,
      endTime,
      duration,
      chapters,
      isActive: isActive || false,
      status,
      createdBy: req.admin._id,
    });

    res.status(201).json({ message: "Exam created successfully", exam });
  } catch (error) {
    console.error("Error creating exam:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

export const getAdminExams = async (req, res) => {
  try {
    const exams = await ExamModel.find().sort({ startTime: -1 });
    res.status(200).json(exams);
  } catch (error) {
    console.error("Error fetching exams:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

export const getExamById = async (req, res) => {
  try {
    const exam = await ExamModel.findById(req.params.id)
      .populate("chapters.quizIds")
      .populate("participants.user", "name email");
    
    if (!exam) return res.status(404).json({ message: "Exam not found" });
    res.status(200).json(exam);
  } catch (error) {
    console.error("Error fetching exam:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

export const updateExam = async (req, res) => {
  try {
    const updateData = req.body;
    
    if (updateData.startTime || updateData.endTime) {
       const start = updateData.startTime ? new Date(updateData.startTime) : undefined;
       const end = updateData.endTime ? new Date(updateData.endTime) : undefined;
       // Status updating logic should ideally be a cron job, but we'll approximate it here if changed.
    }

    const exam = await ExamModel.findByIdAndUpdate(req.params.id, updateData, { new: true });
    if (!exam) return res.status(404).json({ message: "Exam not found" });

    res.status(200).json({ message: "Exam updated successfully", exam });
  } catch (error) {
    console.error("Error updating exam:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

export const deleteExam = async (req, res) => {
  try {
    const exam = await ExamModel.findByIdAndDelete(req.params.id);
    if (!exam) return res.status(404).json({ message: "Exam not found" });
    res.status(200).json({ message: "Exam deleted successfully" });
  } catch (error) {
    console.error("Error deleting exam:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

// -- USER CONTROLLERS --

export const getPublicExams = async (req, res) => {
  try {
    const { status } = req.query; // UPCOMING, LIVE, ENDED
    const query = { isActive: true };
    if (status) query.status = status;

    const exams = await ExamModel.find(query).sort({ startTime: 1 }).select("-chapters.quizIds -participants");
    res.status(200).json(exams);
  } catch (error) {
    console.error("Error fetching public exams:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

export const getExamDetailsForUser = async (req, res) => {
  try {
    const exam = await ExamModel.findById(req.params.id)
      .populate("chapters.quizIds")
      .populate("participants.user", "name username avatar profilePicture title isPremium");
    if (!exam || !exam.isActive) return res.status(404).json({ message: "Exam not found" });

    // Hide correct answers from the user before submission
    const safeExam = exam.toObject();
    safeExam.chapters.forEach(chapter => {
      chapter.quizIds.forEach(quiz => {
        if (quiz.type === "mcq" && quiz.options) {
          quiz.options.forEach(opt => delete opt.isCorrect);
        } else if (quiz.type === "column_matching" && quiz.pairs) {
           // We need to shuffle them or send separately on frontend, but backend sends pairings.
           // The frontend handles the drag and drop. Standard practice is to send them. 
           // We just don't tell them what matches what in a direct "answer key" field, 
           // though the `pairs` array dictates it. The frontend should shuffle `rightItem`.
        }
      });
    });

    res.status(200).json(safeExam);
  } catch (error) {
    console.error("Error fetching exam details:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

export const joinExam = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const exam = await ExamModel.findById(id);
    if (!exam) return res.status(404).json({ message: "Exam not found" });

    if (exam.status === "ENDED") {
      return res.status(400).json({ message: "Exam has ended" });
    }

    const existingParticipation = exam.participants.find(p => p.user.toString() === userId.toString());
    if (existingParticipation) {
      return res.status(400).json({ message: "Already joined" });
    }

    exam.participants.push({ user: userId, joinedAt: new Date() });
    await exam.save();
    
    // Return populated user for immediate UI update if desired
    const populatedExam = await ExamModel.findById(id).populate("participants.user", "name username avatar profilePicture title isPremium");
    
    res.status(200).json({ message: "Joined successfully", participants: populatedExam.participants });
  } catch (error) {
    console.error("Error joining exam:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

export const submitExam = async (req, res) => {
  try {
    const { id } = req.params;
    const { answers } = req.body; // Array of { quizId, selectedOption, matchedPairs: [{left, right}] }
    const userId = req.user._id;

    const exam = await ExamModel.findById(id).populate("chapters.quizIds");
    if (!exam) return res.status(404).json({ message: "Exam not found" });

    // Check if user already submitted
    const existingParticipant = exam.participants.find(p => p.user.toString() === userId.toString());
    if (existingParticipant && existingParticipant.submittedAt) {
      return res.status(400).json({ message: "You have already submitted this exam." });
    }

    let score = 0;
    const processedAnswers = [];

    // Calculate score
    for (const answer of answers) {
      const quizId = answer.quizId;
      // Find quiz in populated chapters
      let quizDoc = null;
      for (const chapter of exam.chapters) {
        const found = chapter.quizIds.find(q => q._id.toString() === quizId);
        if (found) { quizDoc = found; break; }
      }

      if (!quizDoc) continue;

      let isCorrect = false;

      if (quizDoc.type === "mcq") {
        const correctOpt = quizDoc.options.find(o => o.isCorrect);
        if (correctOpt && correctOpt._id.toString() === answer.selectedOption) {
          isCorrect = true;
          score += 1; // 1 point per correct MCQ
        }
      } else if (quizDoc.type === "column_matching") {
        let allMatched = true;
        
        if (!answer.matchedPairs || answer.matchedPairs.length === 0) {
          allMatched = false;
        } else {
          for (const correctPair of quizDoc.pairs) {
            const userPair = answer.matchedPairs.find(p => p.leftItem === correctPair.leftItem);
            if (!userPair || userPair.rightItem !== correctPair.rightItem) {
              allMatched = false;
              break;
            }
          }
        }

        if (allMatched && answer.matchedPairs.length === quizDoc.pairs.length) {
          isCorrect = true;
          score += 1; // 1 point per entirely correct column matching
        }
      }

      processedAnswers.push({
        quizId,
        selectedOption: answer.selectedOption,
        matchedPairs: answer.matchedPairs,
        isCorrect
      });
    }

    if (existingParticipant) {
      existingParticipant.score = score;
      existingParticipant.answers = processedAnswers;
      existingParticipant.submittedAt = new Date();
    } else {
      exam.participants.push({
        user: userId,
        score,
        answers: processedAnswers,
        joinedAt: new Date(),
        submittedAt: new Date()
      });
    }

    await exam.save();

    res.status(200).json({ message: "Exam submitted successfully", score });
  } catch (error) {
    console.error("Error submitting exam:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

export const getExamResults = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const exam = await ExamModel.findById(id)
      .populate("chapters.quizIds")
      .populate("participants.user", "name username avatar profilePicture title isPremium");
    
    if (!exam) return res.status(404).json({ message: "Exam not found" });

    const participant = exam.participants.find(p => {
      const pUserId = p.user._id ? p.user._id.toString() : p.user.toString();
      return pUserId === userId.toString();
    });
    if (!participant) return res.status(404).json({ message: "You have not participated in this exam." });

    res.status(200).json({
      score: participant.score,
      answers: participant.answers,
      examDetails: exam // Can map out only needed details on frontend
    });
  } catch (error) {
    console.error("Error fetching results:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
};
