# Split Hosting

This is a Markdown page


some information


```mermaid
flowchart TD
    subgraph h1[Host 1]
        subgraph iso_net_1[Isolated Docker Network]
            subgraph spacer[ ]
                style spacer fill:none,stroke:none
            end
            autossh[Autossh Container]
            prom[Prometheus Container]
            gql[GraphQL Server Container]
            g[Graphana Container]
        end
        spacer ~~~ autossh
        spacer ~~~ prom
        gql <--> |relay from nginx| autossh
        prom <--> |request to Auth Server| autossh
        ext_net[External Docker Network]
        autossh --- ext_net
    end
    ext_net <--> inet((Internet))
    g <--> |exposed port| inet
    subgraph h2[Host 2]
        subgraph iso_net_2[Isolated Docker Network]
            subgraph spacer1[ ]
                style spacer1 fill:none,stroke:none
            end
            ssh_server[SSH Server Container]
            h2auth[Auth Server Container]
            nginx[Nginx Container]
        end
        spacer1 ~~~ ssh_server
        spacer1 ~~~ h2auth
        ssh_server <--> |relay from Prometheus| h2auth 
        ssh_server <--> |request to GraphQL Server| nginx
    end
    inet ~~~ spacer1
    inet <--> |exposed port| ssh_server
    cf_daemon[Cloudflare Daemon] <--> |exposed port| nginx
    inet <--> cf_daemon
```