import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Users from "../../models/users/userModel.js";
import Session from "../../models/session/sessionModel.js";
import Role from "../../models/role/roleModel.js";

const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL = "14d";
const REFRESH_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// user.role phải đã được populate (có field code)
const generateToken = (user) => {
  const accessToken = jwt.sign(
    { id: user._id, role: user.role?.code },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL },
  );

  const refreshToken = jwt.sign(
    { id: user._id },
    process.env.REFRESH_TOKEN_SECRET,
    { expiresIn: REFRESH_TOKEN_TTL },
  );

  return { accessToken, refreshToken };
};

const setRefreshTokenCookie = (res, refreshToken) => {
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: REFRESH_TOKEN_TTL_MS,
  });
};

export const authController = {
  // Đăng ký người dùng mới
  registerUser: async (req, res) => {
    try {
      const { name, email, password } = req.body;

      if (!name || !email || !password) {
        return res
          .status(400)
          .json({ message: "Please provide name, email, and password" });
      }

      const existingUser = await Users.findOne({ email });
      if (existingUser) {
        return res.status(400).json({ message: "User already exists" });
      }

      // Lấy role mặc định
      const defaultRole = await Role.findOne({ code: "USER", isActive: true });
      if (!defaultRole) {
        return res.status(500).json({ message: "Default role not found" });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const newUser = new Users({
        name,
        email,
        password: hashedPassword,
        role: defaultRole._id,
      });

      await newUser.save();
      res.status(201).json({ message: "User registered successfully" });
    } catch (error) {
      console.log(error);
      res.status(500).json({ message: error.message });
    }
  },

  // Đăng nhập người dùng
  loginUser: async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res
          .status(400)
          .json({ message: "Please provide email and password" });
      }

      // Populate role để đưa code vào token
      const user = await Users.findOne({ email }).populate(
        "role",
        "name code isActive",
      );
      if (!user) {
        return res.status(400).json({ message: "Your email is invalid." });
      }

      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(400).json({ message: "Your password is invalid." });
      }

      if (!user.role || !user.role.isActive) {
        return res
          .status(403)
          .json({ message: "Your account role is inactive." });
      }

      const { accessToken, refreshToken } = generateToken(user);

      await Session.create({
        userId: user._id,
        refreshToken,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      });

      setRefreshTokenCookie(res, refreshToken);

      res.status(200).json({
        message: `User ${user.name} logged in successfully`,
        accessToken,
        role: user.role.code, // cho frontend ẩn/hiện menu
      });
    } catch (error) {
      console.log(error);
      res.status(500).json({ message: error.message });
    }
  },

  // Đăng xuất người dùng
  logoutUser: async (req, res) => {
    try {
      const token = req.cookies.refreshToken;

      if (!token) {
        return res.status(400).json({ message: "Refresh token not found" });
      }

      await Session.deleteOne({ refreshToken: token });
      res.clearCookie("refreshToken");

      res.status(200).json({ message: "User logged out successfully" });
    } catch (error) {
      console.log(error);
      res.status(500).json({ message: error.message });
    }
  },

  // Refresh token
  refreshToken: async (req, res) => {
    try {
      const refreshToken = req.cookies.refreshToken;
      if (!refreshToken) {
        return res.status(401).json({ message: "Refresh token not found" });
      }

      const session = await Session.findOne({ refreshToken });
      if (!session) {
        return res.status(403).json({ message: "Invalid refresh token" });
      }

      if (session.expiresAt < new Date()) {
        await Session.deleteOne({ refreshToken });
        return res.status(403).json({ message: "Refresh token expired" });
      }

      // Populate lại role để token mới mang role mới nhất
      const user = await Users.findById(session.userId).populate(
        "role",
        "name code isActive",
      );
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      if (!user.role || !user.role.isActive) {
        await Session.deleteOne({ refreshToken });
        return res
          .status(403)
          .json({ message: "Your account role is inactive." });
      }

      const { accessToken, refreshToken: newRefreshToken } =
        generateToken(user);

      session.refreshToken = newRefreshToken;
      session.expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
      await session.save();

      setRefreshTokenCookie(res, newRefreshToken);

      res.status(200).json({ accessToken, role: user.role.code });
    } catch (error) {
      console.log(error);
      res.status(500).json({ message: error.message });
    }
  },
};