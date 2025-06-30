#!/bin/bash

echo "i am inside container ${WORKDIR_R}"

if [ -z "$1" ] || [ ! -d "$1" ]; then
  echo "Source folder does not exist or not set: $1"
  exit 1
fi

if [ -z "$2" ] || [ ! -d "$2" ]; then
  echo "Work folder does not exist or not set: $2"
  exit 1
fi

echo "$(date) Accepted folders $1 $2 aaand $SERVICE_FOLDER andanother ${OPA}"
ls "$1/$SERVICE_FOLDER"

if [ -z "$SERVICE_FOLDER" ] || [ ! -d "$1/$SERVICE_FOLDER" ]; then
  echo "Service folder does not exist or not set: $SERVICE_FOLDER. Configure it in docker compose file."
  exit 1
fi

ln -s "$1/package.json" "$2"/
ln -s "$1/$SERVICE_FOLDER" "$2"/
ln -s "$1/common" "$2"/
ln -s "$1/tsconfig.json" "$2"/

cd "$2" || exit
npm install
if [ -d "$NGINX_SHARE_FOLDER" ]; then
  cp "./*/*.html" "$NGINX_SHARE_FOLDER"
  tsc
  cp -rfd build/* "$NGINX_SHARE_FOLDER"
else
npm run go
fi
