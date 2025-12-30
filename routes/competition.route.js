import express from 'express';
import {
  createCompetition,
  getCompetitions,
  getCompetitionById,
  updateCompetition,
  deleteCompetition,
  joinCompetition,
  submitSolution,
  finishParticipation,
  getLeaderboard,
  getPuzzlesForCompetition
} from '../controllers/competition.controller.js';
import isAdmin from '../middleware/admin.middleware.js';
import isUser from '../middleware/user.middleware.js';

const router = express.Router();

// Admin routes
router.post('/create-competition', isAdmin, createCompetition);
router.get('/', getCompetitions);
router.get('/puzzles/for-competition', isAdmin, getPuzzlesForCompetition);
router.get('/:id', getCompetitionById);
router.put('/update-competition/:id', isAdmin, updateCompetition);
router.delete('/delete-competition/:id', isAdmin, deleteCompetition);

// User routes
router.post('/:id/join', isUser, joinCompetition);
router.post('/:id/submit/:puzzleId', isUser, submitSolution);
router.post('/:id/finish', isUser, finishParticipation);
router.get('/:id/leaderboard', getLeaderboard);

export default router;
