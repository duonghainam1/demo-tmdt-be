import {Router} from "express";
import { authController } from "../../controllers/auth/authController.js";

const router = Router();

router.post("/register", authController.registerUser);
router.post("/login", authController.loginUser);
router.post("/logout", authController.logoutUser);
router.post("/refresh-token", authController.refreshToken);


export default router;
