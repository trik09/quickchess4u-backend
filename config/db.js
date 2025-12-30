import mongoose from "mongoose";

const connectDB = async () => {
  try {
    //console.log(process.env.MONGODB_URI);
    console.log("Connecting to MongoDB URI:", process.env.MONGODB_URI ? "Defined" : "Undefined");
    const connection = await mongoose.connect(process.env.MONGODB_URI);
    if (connection) {
      console.log("MongoDB connected");
    }

  } catch (err) {
    console.error("MongoDB connection failed", err);
    process.exit(1);
  }
};



export default connectDB;
