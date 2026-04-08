import mongoose from 'mongoose';
const { Schema } = mongoose;
mongoose.connect('mongodb://127.0.0.1:27017/quickchess').then(async () => {
  const Comp = mongoose.model('Competition', new Schema({}, { strict: false }));
  const Puzzle = mongoose.model('Puzzle', new Schema({}, { strict: false }));
  const latest = await Comp.findOne({}).sort({ createdAt: -1 });
  if (!latest) return console.log('No comp');
  console.log('Comp:', latest.name);
  if (!latest.puzzles) return console.log('No puzzles in comp');
  const puzzles = await Puzzle.find({ _id: { $in: latest.puzzles } });
  puzzles.forEach(p => {
    console.log(p.title, "  |  ", p.category, "  |  ", JSON.stringify(p.illegalConfig), "  |  ", p.firstMoveBy, "  |  ", p.fen);
  });
  process.exit();
}).catch(console.error);
