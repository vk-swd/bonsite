# Deployment

The deployment is done using docker compose. Services described in corresponding compose.yaml files in folders where service specific files are located.

Services are connected with a docker network and locate each other using defined and shared hostnames.


## Compose files and deployment scripts



Tpo deploy a project use the script deploy.py. It makes different modes of deployment using combinations of docker compose files:
| Bundle | Contents |
|--------|----------|
| Fnet   | networks (backend_net, edge_net) and shared volumes |
| Bcore  | backend core: gql, generator, kafka, db stack, monitoring |
| Btun   | backend tunnel client (connects Bcore to a remote frontend) |
| Fcore  | frontend core: builder + nginx |
| Fauth  | frontend auth: auth server + redis |
| Ftun   | frontend tunnel server (SSH reverse-tunnel entry point) |

The modes of deployment are selected as shown below:
<figure>

```mermaid
graph TB
    subgraph SA["Single host + login: BONSITE_USER_ENV=*your file* python deploy.py up -d"]
        direction LR
        SA_FNET["Fnet.yaml"]
        SA_BCORE["Bcore.yaml"]
        SA_FCORE["Fcore.yaml"]
        SA_FAUTH["Fauth.yaml"]
        SA_LGQL["link_nginx_to_gql.yaml"]
        SA_FNET ~~~ SA_BCORE ~~~ SA_FCORE ~~~ SA_FAUTH ~~~ SA_LGQL
    end

    subgraph SN["Single host, no login: BONSITE_USER_ENV=*your file* python deploy.py --no-auth up -d"]
        direction LR
        SN_FNET["Fnet.yaml"]
        SN_BCORE["Bcore.yaml"]
        SN_FCORE["Fcore.yaml"]
        SN_LGQL["link_nginx_to_gql.yaml"]
        SN_FNET ~~~ SN_BCORE ~~~ SN_FCORE ~~~ SN_LGQL
    end

    subgraph SFA["Split hosting, front, login: BONSITE_USER_ENV=*your file* python deploy.py --split-f up -d"]
        direction LR
        SFA_FNET["Fnet.yaml"]
        SFA_FCORE["Fcore.yaml"]
        SFA_FAUTH["Fauth.yaml"]
        SFA_FTUN["Ftun.yaml"]
        SFA_LTUN["link_nginx_to_tunnel.yaml"]
        SFA_FNET ~~~ SFA_FCORE ~~~ SFA_FAUTH ~~~ SFA_FTUN ~~~ SFA_LTUN
    end

    subgraph SFN["Split hosting, front, no login: BONSITE_USER_ENV=*your file* python deploy.py --split-f --no-auth up -d"]
        direction LR
        SFN_FNET["Fnet.yaml"]
        SFN_FCORE["Fcore.yaml"]
        SFN_FTUN["Ftun.yaml"]
        SFN_LTUN["link_nginx_to_tunnel.yaml"]
        SFN_FNET ~~~ SFN_FCORE ~~~ SFN_FTUN ~~~ SFN_LTUN
    end

    subgraph SB["Split hosting, back: BONSITE_USER_ENV=*your file* python deploy.py --split-b up -d"]
        direction LR
        SB_FNET["Fnet.yaml"]
        SB_BCORE["Bcore.yaml"]
        SB_BTUN["Btun.yaml"]
        SB_FNET ~~~ SB_BCORE ~~~ SB_BTUN
    end

    SA ~~~ SN
    SN ~~~ SFA
    SFA ~~~ SFN
    SFN ~~~ SB
    classDef fnet    fill:#4a235a,stroke:#c39bd3,color:#f5eef8
    classDef bcore   fill:#1a3a5c,stroke:#5dade2,color:#eaf4fb
    classDef btun    fill:#1a3a5c,stroke:#5dade2,color:#eaf4fb
    classDef fcore   fill:#1d4e2a,stroke:#58d68d,color:#eafaf1
    classDef fauth   fill:#4a3000,stroke:#f0b429,color:#fef9e7
    classDef ftun    fill:#1d4e2a,stroke:#58d68d,color:#eafaf1
    classDef overlay fill:#2d1b4e,stroke:#9b72cf,color:#f0e8ff

    class SA_FNET,SN_FNET,SFA_FNET,SFN_FNET,SB_FNET fnet
    class SA_BCORE,SN_BCORE,SB_BCORE bcore
    class SB_BTUN btun
    class SA_FCORE,SN_FCORE,SFA_FCORE,SFN_FCORE fcore
    class SA_FAUTH,SFA_FAUTH fauth
    class SFA_FTUN,SFN_FTUN ftun
    class SA_LGQL,SN_LGQL,SFA_LTUN,SFN_LTUN overlay
```


</figure>

BONSITE_USER_ENV - this variable should define the file holding [variables necessary for the project](#user-variables-with-sample-values).

## Environment variables

The following kinds of variables are used:

1. Most variables are described in a single .env file in the root folder and they are shared across projects.
    1. To avoid collisions variables have prefixes of their service
2. Some variables that are not shared with any other service are placed in the service folder. Like the sqldb/.env
3. Some variables should not have default values, like the variables for passwords or some host system folders. Those are expected to be set by a user in a dedicated [file](#user-variables-with-sample-values). They are marked in (1) as required variables and the user should provide their definitions.

## User variables with sample values:

Nothing will work unless those are provided.

<figure>
```
CLOUDFLARE_SECRET="0xSOME_SECRET_CLOUDFLARE_SECRET"
FRONTEND_DEPLOY_FOLDER_HOST="/FULL PATH TO A FOLDER/.../nginxfiles"
MSSQL_UNIVERSAL_PASSWORD="SOME_SECRET_PASSWORD"
TUNNEL_CLIENT_PRIVATE_KEY_TO_MOUNT="/FULL PATH TO A KEY FOLDER/.../some_key_file"
TUNNEL_CLIENT_PUBLIC_KEY_TO_MOUNT="/FULL PATH TO A KEY FOLDER/.../some_key_file.pub"
LOG_MOUNT_HOST="/FULL PATH TO A LOG FOLDER/.../logfolder"
TUNNEL_CLIENT_SERVER_ADDR="192.168.1.10"
GOOGLE_CLIENT_ID = "SOME_GOOGLE_CLIENT_ID"
GOOGLE_CLIENT_SECRET = "SOME_SECRET_GOOGLE_CLIENT_SECRET"
```
</figure>

GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set and chosen at https://console.cloud.google.com/auth/clients

CLOUDFLARE_SECRET is set at cloudflare dashboard and implementation instructions are described at https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/

## Other configurable variables

Those could be defined by user. Or default values will be used.

```
NGINX_HOST_ADDR - addr:port or port - which host addr to expose nginx at.
NGINX_CONF_FILE - Nginx has 2 configuration files. One with the authorization and on without. By default the ./f.conf file is loaded - it contains authorization. The alternative value would be set by the deployment script.
GRAFANA_EXPOSED_PORT_ADDR - addr:port or port - which host addr to expose Grafana at.
```


## How to start this

1. For split hosted bundles
``` 
SPLIT_HOSTED=true docker compose --env-file .env --env-file *file_of_your_choice* -f deploy_split_host_back.yaml up deploy

SPLIT_HOSTED=true docker compose --env-file .env --env-file *file_of_your_choice* -f deploy_split_host_front.yaml up deploy

```

2. For single hosted bundle

```
docker compose --env-file .env --env-file *file_of_your_choice* -f deploy_single_host.yaml up deploy
```

## Compose files structure
<figure>
```mermaid
flowchart LR
    subgraph Services
        subgraph Front
            fb[frontend_builder/compose.yaml]
            nginx[nginx_server/compose.yaml]
            auth[auth/compose.yaml]
            sshS[tunnel/compose.yaml]
        end
        subgraph Back
            sshC[tunnel_client/compose.yaml]
            gql[gql/compose.yaml]
            gen[generator/compose.yaml]
            kafka[kafka/compose.yaml]
            sink[message_sink/compose.yaml]
            sqldb[sqldb/compose.yaml]
            dbi[db_initializer/compose.yaml]
            sg[statement_generator/compose.yaml]
            prom[prometheus/compose.yaml]
            graf[grafana/compose.yaml]
        end
    end 
    dsh[deploy_single_host.yaml] --> fb & nginx & auth & gql & gen & kafka & sink & sqldb & dbi & sg & prom & graf
    
    fb & nginx & auth & sshS --> dshf[deploy_split_host_front.yaml]
    
    sshC & gql & gen & kafka & sink & sqldb & dbi & sg & prom & graf --> dshb[deploy_slit_host_back.yaml]
```
</figure>



## Service Startup Order (within each deploy file)

<figure>
```mermaid
flowchart TD
    subgraph back ["Back / Single host"]
        SQLDB[sqldb] --> SQL_MON[sql_monitor]
        SQL_MON -->|healthy| DBINIT[db_initializer]
        DBINIT -->|completed| SINK[message_sink]
        DBINIT -->|completed| STMTGEN[statement_generator]

        KAFKA[kafka] -->|healthy| KAFKAINIT[kafka-init]
        KAFKAINIT -->|completed| GEN[generator]
        KAFKAINIT -->|completed| SINK

        GQL[gql] -->|healthy| TUNNELCL[tunnel_client]
        GQL[gql] -->|started| NGINX[nginx_server]
        REDIS[redis] -->|started| AUTH[auth]

        TUNNEL[tunnel server] -->|started| NGINX
        FB[frontend_builder] -->|completed| NGINX
    end
```
</figure>


## Network topolory
<div id="net-top" style={{scrollMarginTop: '80px'}}></div>
<figure>
```mermaid
flowchart TD
    subgraph h1[Host]
        subgraph iso_net_1[Isolated Network]
            g[Grafana]
            nginx[Nginx]
            others[Other Containers]
        end
        others --- nginx
        others --- g
        g --> nic[External Docker Network]
        nginx -->  nic
    end
    nic <--> |exposed ports| inet((Internet/Users))
```
<figcaption>Services are kept within isolated network perimeter unless they need their ports exposed </figcaption>
</figure>



<a id="notes-anchor"></a>
## Notes

1. The deployment and system robustness could be improved with service discovery health monitoring and automatic resource allocation, but it was not in the scope.
2.  Docker swarm could be used to orchestrate deployment during the split hosting layout, which would simplify things and not require a usage of ssh servers, but I was using a rootless docker for deployment just to be sure and in this mode swarm does not work. 
3. Since v3 docker compose the "service_completed_successfully" condition does not differentiate exit error codes so chaining tests got trickier and I let the services running tests linger after completion to make a health.txt file which is checked by health checks. It is hacky but it works for all intended purposes purposes.