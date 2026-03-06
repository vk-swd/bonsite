Backend is deployed in rootless user with rootlss docker



Frontend is started automatically when its machine is run with the service file

.config/systemd/user/myFrontEnd.service                                                     
[Unit]
Description=frontend docker containers
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/duser/app
Environment=DOCKER_HOST=unix:///run/user/1002/docker.sock
ExecStart=/usr/bin/docker compose --env-file /home/duser/someenv --env-file /home/duser/app/.env up tunnel auth nginx_server -d
ExecStop=/usr/bin/docker compose --env-file /home/duser/someenv --env-file /home/duser/app/.env  down -t 0

RestartSec=5s


sudo systemctl enable openvpn_client1.service  - to make it run on startup

deploying the code to frontend:
copy code to frontend code folder:
rsync -av --progress --exclude='.git' ./ duser@10.8.0.2:apps
systemctl --user restart myFrontEnd.service 
journalctl --user -u myFrontEnd.service -e




[Unit]
Description=backend docker containers
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/duser/appl
Environment=DOCKER_HOST=unix:///run/user/$(id -u $USER)/docker.sock
ExecStartPre=/usr/bin/docker compose build
ExecStart=/usr/bin/docker compose --env-file /home/duser/someenv --env-file /home/duser/app/.env up backend -d
ExecStop=/usr/bin/docker compose --env-file /home/duser/someenv --env-file /home/duser/app/.env  down -t 0
RestartSec=5s


[Unit]
Description=backend docker containers
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/duser/appl
Environment=DOCKER_HOST="unix:///run/user/1007/docker.sock"
ExecStartPre=/usr/bin/docker compose build
ExecStart=/usr/bin/docker compose --env-file /home/duser/someenv --env-file /home/duser/appl/.env up backend -d
ExecStop=/usr/bin/docker compose --env-file /home/duser/someenv --env-file /home/duser/appl/.env  down -t 0
OnFailure=/usr/bin/docker compose --env-file /home/duser/someenv --env-file /home/duser/appl/.env  down -t 0
RestartSec=5s
