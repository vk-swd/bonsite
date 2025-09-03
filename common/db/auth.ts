import { getEnv, last } from '../utils.js'


const user_consumer = getEnv('MSSQL_CONSUMER_USERNAME')
const user_statement_creator = getEnv('MSSQL_STATEMENT_CREATOR_USERNAME')

export const roles = [`${user_consumer}_role`, `${user_statement_creator}_role`, `test_role`];
export const [sinkRole,  statementCreatorRole, testRole] = roles
export const users: {name: string, login: string}[] = [
    {name: `${user_consumer}_user`, login: `${user_consumer}_login`},
    {name: `${user_statement_creator}_user`, login: `${user_statement_creator}_login`},
    {name: `${testRole}_user`, login: `${testRole}_login`}]
export const [consumerUser, statementUser, testUser] = users
