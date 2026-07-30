import { Router } from "express";
import { devicesRouter } from "./devices";
import { recordsRouter } from "./records";

const pestCalibrationRouter = Router();

pestCalibrationRouter.use(devicesRouter);
pestCalibrationRouter.use(recordsRouter);

export { pestCalibrationRouter };
