#!/bin/bash


su ${TUNNEL_USER_NAME} -c 'ssh -f   -N -R ${GRAPH_QL_REMOTE_PORT}:${GRAPH_QL_APP_NAME}:${GRAPH_QL_PORT} ${TUNNEL_USER_NAME}@${FRONTEND_HOST}-p ${TUNNEL_PORT} -i ~/.ssh/tunnel;'; \
su ${TUNNEL_USER_NAME} -c 'ssh -f -o StrictHostKeyChecking=no -N -L ${AUTH_SERVER_MON_PORT}:${AUTH_APP_NAME}:${MONITORING_PORT} ${TUNNEL_USER_NAME}@${FRONTEND_HOST} -p ${TUNNEL_PORT} -i ~/.ssh/tunnel;'; \
            
ssh 
-f -N 
-R ${GRAPH_QL_REMOTE_PORT}:${GRAPH_QL_APP_NAME}:${GRAPH_QL_PORT} 
${TUNNEL_USER_NAME}@${FRONTEND_HOST}
-p ${TUNNEL_PORT} 
-i ~/.ssh/tunnel;


AUTOSSH_GATETIME=0 AUTOSSH_LOGFILE=/home/sshuser/autologs  AUTOSSH
_GATETIME=0 autossh -M 0 -f -o ExitOnForwardFailure=yes -o ServerAlive
Interval=2 -o ServerAliveCountMax=2 -o StrictHostKeyChecking=no -N -R 
redacted:localhost:redacted sshuser@redacted -p 2222  -i /home/sshuser/.s
sh/tunnel
