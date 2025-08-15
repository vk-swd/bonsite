
import { getEnv } from "./build/common/utils.js";
import { logger } from "./build/common/logger.js";
logger.log("Starting healthcheck server...");
const port = getEnv("HEALTHCHECK_PORT");
fetch(`http://localhost:${port}/`)
            .then(res => {
                logger.log("Healthcheck response:" + JSON.stringify(res));
                if (!res.ok) {
                    logger.error("Healthcheck not ok:" + JSON.stringify(err));
                    exit(1);
                }
            })
            .catch(err => {
                logger.error("Healthcheck error:" + JSON.stringify(err));
                exit(1);
            });
    