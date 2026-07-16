import { Router } from "express";
import { departmentsRouter } from "./departments";
import { locationsRouter } from "./locations";
import { templatesRouter } from "./templates";
import { recordsRouter } from "./records";
import { recordLifecycleRouter } from "./recordLifecycle";

// Combined Food Safety router — mounted once in app.ts, after
// requireOrganizationContext. Individual entities (departments, locations,
// templates/versions, records/lifecycle, and future entities) each get
// their own route file under this folder rather than one large
// routes/foodSafety.ts file, since this module spans far more entities than
// any existing single-file feature.
const foodSafetyRouter = Router();

foodSafetyRouter.use(departmentsRouter);
foodSafetyRouter.use(locationsRouter);
foodSafetyRouter.use(templatesRouter);
foodSafetyRouter.use(recordsRouter);
foodSafetyRouter.use(recordLifecycleRouter);

export { foodSafetyRouter };
