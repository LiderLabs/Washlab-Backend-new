import pino from "pino";
import { config } from "../config/index.js";

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "*.password",
      "*.stationPin",
      "*.stationPinHash",
      "*.passcode",
      "*.passcodeHash",
      "*.token",
      "*.plainToken",
      "*.secret",
      "*.biometricData",
      "*.creditCard",
    ],
    remove: true,
  },
});
