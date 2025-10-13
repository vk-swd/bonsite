import { getEnv } from '../utils.js'

import sql from 'mssql'



export const database = getEnv('MSSQL_DB_NAME')
export const server = getEnv('MSSQL_HOSTNAME')
export const demo_password = getEnv('MSSQL_PASSWORD')

export async function connectToDatabase(login: string, database?: string): Promise<sql.ConnectionPool> {
    const res = new sql.ConnectionPool({
        user: login,
        password: demo_password,
        requestTimeout: 90000,
        server,
        database,
        options: { trustServerCertificate: true }
    });
    await res.connect();
    return res;
}


export function runQuery(pool: sql.ConnectionPool, query: string): Promise<sql.IResult<any>> {
    return pool.request().query(query).catch(e => {
        console.log(`Error running query: ${query}`, e);
        throw e;
    });
}