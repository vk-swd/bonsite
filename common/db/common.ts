import { getEnv } from '../utils.js'

import sql from 'mssql'

export async function connectToDatabase(login: string, 
    passwd: string, 
    sql_hostname: string,
    database: string): Promise<sql.ConnectionPool> {
    const res = new sql.ConnectionPool({
        user: login,
        password: passwd,
        requestTimeout: 90000,
        server: sql_hostname,
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