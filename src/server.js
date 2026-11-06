import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import connectDatabase from "./configs/db.js";
import indexRoute from "./routes/indexRoute.js";
import cookieParser from "cookie-parser";
dotenv.config();

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(cors({
    origin: "https://demo-tmdt-fe.vercel.app", // đúng origin frontend đang chạy
    credentials: true, // nếu bạn dùng cookie/session, nếu chỉ dùng JWT trong header thì có thể bỏ
}));
app.use("/api", indexRoute);

const PORT = process.env.PORT || 5000;

const startServer = async () => {
    await connectDatabase();
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
};
// 7584
startServer();