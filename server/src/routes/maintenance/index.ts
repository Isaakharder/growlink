import { Router } from "express";
import { setupRouter } from "./setup";
import { equipmentRouter } from "./equipment";
import { qrRouter } from "./qr";
import { metersRouter } from "./meters";
import { schedulesRouter } from "./schedules";
import { inventoryRouter } from "./inventory";
import { transactionsRouter } from "./transactions";
import { restockRouter } from "./restock";
import { stockCountsRouter } from "./stockCounts";
import { reportsRouter } from "./reports";
import { badgesRouter } from "./badges";
import { workLogsRouter } from "./workLogs";

const maintenanceRouter = Router();

maintenanceRouter.use(setupRouter);
maintenanceRouter.use(equipmentRouter);
maintenanceRouter.use(qrRouter);
maintenanceRouter.use(metersRouter);
maintenanceRouter.use(workLogsRouter);
maintenanceRouter.use(schedulesRouter);
maintenanceRouter.use(inventoryRouter);
maintenanceRouter.use(transactionsRouter);
maintenanceRouter.use(restockRouter);
maintenanceRouter.use(stockCountsRouter);
maintenanceRouter.use(reportsRouter);
maintenanceRouter.use(badgesRouter);

export { maintenanceRouter };
