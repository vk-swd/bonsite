#!/bin/sh

CLIENT_KEY_IN_CONTAINER="/home/$TUNNEL_USER_NAME/.ssh/tunnel"
cp $CLIENT_KEY $CLIENT_KEY_IN_CONTAINER
cp $CLIENT_KEY.pub $CLIENT_KEY_IN_CONTAINER.pub
chown -R ${TUNNEL_USER_NAME} /home/${TUNNEL_USER_NAME}/.ssh
echo "Client key copied to container."
su ${TUNNEL_USER_NAME} -c "AUTOSSH_GATETIME=0 \
    AUTOSSH_LOGFILE="$LOG_MOUNT/autossh_logs.log" \
    autossh -M 0 \
    -f \
    -o StrictHostKeyChecking=no \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=10 \
    -o ServerAliveCountMax=2 \
    -vv \
    -R $REMOTE_LISTEN_PORT:$LOCAL_LISTEN_ADDR:$LOCAL_LISTEN_PORT \
    -L $LOCAL_CONNECT_PORT:$REMOTE_CONNECT_ADDR:$REMOTE_CONNECT_PORT \
    -N $TUNNEL_USER_NAME@$REMOTE_END_ADDR \
    -i $CLIENT_KEY_IN_CONTAINER \
    -p $REMOTE_END_PORT;"
