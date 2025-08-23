
import * as mtrx from "./monitoring_local.js";
import { logger } from "./common/logger.js";
import { Sink } from "./sink.js";

async function crash(error: any): Promise<Error>{
    mtrx.metrics?.crashCount?.inc(1)
    await mtrx.dumpRegistry();
    logger.log(`Pre-crash wrap up done, exiting...${error}`);
    throw error
}

async function main() {
    let sink: Sink;
    try {
        sink = await Sink.create();
    } catch (e) {
        throw crash(e);
    }
}

main();
