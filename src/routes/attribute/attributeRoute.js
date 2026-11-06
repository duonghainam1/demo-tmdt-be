import { Router } from "express";
import attributeController from "../../controllers/attribute/attributeController.js";
import { can } from "../../middlewares/authMiddleware.js";

const router = Router();

router.get("/", can("attribute:read"), attributeController.getAttributes);
router.post("/", can("attribute:create"), attributeController.createAttribute);
router.put("/:id", can("attribute:update"), attributeController.updateAttribute);
router.delete("/:id", can("attribute:delete"), attributeController.deleteAttribute);
export default router;