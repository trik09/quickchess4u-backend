import mongoose from "mongoose";

const connectDB = async () => {
  try {

    const connection = await mongoose.connect(process.env.MONGODB_URI);
    if(connection){
        console.log("MongoDB connected");
    }
    
  } catch (err) {
    console.error("MongoDB connection failed", err);
    process.exit(1);
  }
};



export default connectDB;
