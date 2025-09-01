import * as fsp from 'fs/promises';
import { boolean } from "zod";
import { InKafkaMessage, StatementParameters } from "./common/event_types.js";
import { getEnv } from './common/utils.js';
import { UserConnection } from "./common/db/db_defines.js";

let requestCount = 0;
const SHARED_DIR = getEnv('SHARED_DIR');


export async function prepareStatement(p: StatementParameters, db_connection: UserConnection): Promise<string> {
    const fileName = `statement-${requestCount++}-${Date.now()}.json`;
    const handle = await fsp.open(SHARED_DIR + "/" + fileName, 'a') ;
    let error: string = "";
    try {
        //TODO: return list of files, amend GQL and other places
    } catch (e) {
        error += `Error streaming transactions into file ${fileName}: ${e}`;
    }
    await handle.close().catch(_ => {});
    if (error) {
        throw new Error(error);
    }
    return fileName;
}