import { Router } from "express";
import { departmentsRouter } from "./departments";
import { locationsRouter } from "./locations";

// Combined Food Safety router — mounted once in app.ts, after
// requireOrganizationContext. Individual entities (departments, locations,
// and future entities) each get their own route file under this folder
// rather than one large routes/foodSafety.ts file, since this module spans
// far more entities than any existing single-file feature.
const foodSafetyRouter = Router();

foodSafetyRouter.use(departmentsRouter);
foodSafetyRouter.use(locationsRouter);

export { foodSafetyRouter };
