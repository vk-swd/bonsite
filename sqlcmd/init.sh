#!/bin/bash

# A setvar hack is borrowed from:
# https://stackoverflow.com/questions/11668193/using-variables-in-sqlcmd-for-linux

echo :setvar MSSQL_CONSUMER_PASSWORD "$MSSQL_CONSUMER_PASSWORD" > param_input.sql
echo :setvar MSSQL_CONSUMER_USERNAME "$MSSQL_CONSUMER_USERNAME" >> param_input.sql
cat /src/initDB.sql >> param_input.sql
/opt/mssql-tools/bin/sqlcmd -S sqldb -U sa -P "$MSSQL_SA_PASSWORD" -i param_input.sql

