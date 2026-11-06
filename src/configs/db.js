import mongoose from "mongoose";

const connectDatabase = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI || "");
        console.log("Database connected");
    } catch (error) {
        console.error("Database connection error:", error);
        process.exit(1); // dừng app nếu không kết nối được DB
    }
};

export default connectDatabase;