import { Router } from "express";
import { getInventory, getInventoryTransactions, importInventory, stocktakeInventory } from "../../controllers/inventory/inventoryControllerTest.js";
import { can } from "../../middlewares/authMiddleware.js";

const router = Router();

router.get("/", can("inventory:read"), getInventory);
router.get("/:inventoryId/transactions", can("inventory:read"), getInventoryTransactions);
router.post("/stocktake", can("inventory:adjust"), stocktakeInventory);
router.post("/import", can("inventory:adjust"), importInventory);

export default router;
