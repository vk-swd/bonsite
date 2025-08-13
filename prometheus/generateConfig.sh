#!/bin/sh

services="$DB_CONSUMER_NAME $GRAPH_QL_APP_NAME $GENERATOR_NAME"

job() {
    echo "  - job_name: '$1'"
    echo "    scrape_interval: 4s"
    echo "    scrape_timeout: 1s"
    echo "    static_configs:"
    echo "      - targets: ['$2:$3']"
}

echo "scrape_configs:"
job prometheus localhost 9090 
for svc in $services; do
    job "$svc" "$svc" "$MONITORING_PORT"
done