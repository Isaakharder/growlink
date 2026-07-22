import { Router } from "express";
import { cleaningLocationsRouter } from "./cleaningLocations";
import { mobileCleaningChecklistRouter } from "./mobileCleaningChecklist";
import { reportsRouter } from "./reports";

const foodSafetyRouter = Router();

foodSafetyRouter.use(cleaningLocationsRouter);
foodSafetyRouter.use(mobileCleaningChecklistRouter);
foodSafetyRouter.use(reportsRouter);

export { foodSafetyRouter };
