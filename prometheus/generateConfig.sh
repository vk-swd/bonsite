#!/bin/sh

services=$PROM_LOCAL_SERVICES_HOSTNAMES

job() {
    echo "  - job_name: '$1'"
    echo "    scrape_interval: 4s"
    echo "    scrape_timeout: 1s"
    echo "    static_configs:"
    echo "      - targets: ['$2:$3']"
}

echo "scrape_configs:"
job prometheus localhost $PROMETHEUS_PORT
for svc in $services; do
    job "$svc" "$svc" "$MONITORING_PORT"
done
JOB auth_server $PROM_AUTH_APP_HOSTNAME $PROM_AUTH_APP_MONITORING_PORT