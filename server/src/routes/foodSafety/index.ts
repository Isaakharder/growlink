import { Router } from "express";
import { departmentsRouter } from "./departments";
import { locationsRouter } from "./locations";
import { templatesRouter } from "./templates";

// Combined Food Safety router — mounted once in app.ts, after
// requireOrganizationContext. Individual entities (departments, locations,
// templates/versions, and future entities) each get their own route file
// under this folder rather than one large routes/foodSafety.ts file, since
// this module spans far more entities than any existing single-file feature.
const foodSafetyRouter = Router();

foodSafetyRouter.use(departmentsRouter);
foodSafetyRouter.use(locationsRouter);
foodSafetyRouter.use(templatesRouter);

export { foodSafetyRouter };
