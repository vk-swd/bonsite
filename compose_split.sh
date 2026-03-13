
#!/bin/sh


SPLIT_HOSTED=true docker compose --env-file "$BONSITE_USER_ENV"  --env-file .env $@