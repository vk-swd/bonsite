
# BonSite
A learning project to study different storage systems.

This is an application made to explore GraphQL, Kafka and SQL Server.

It consists of services described in  [Services](./services/index.md) and it's goal is to build a functional pipeline where events are posted  to a shared message queue and then stored persistently:
🔗 Live Demo: https://bonsite.org
📝 Login: user / genericPublicPassword (or feel free to use OpenID if you don't mind me seeing your email =))


# Installation
The application was meant to be run with docker, so you will need;
1. A docker
2. A file with environment variables. The file must be assigned to the "BONSITE_USER_ENV". This variable is mantioned in the [start up script](./compose.sh) and it must contain the variables described in [documentation](documentation/docs/deployment/index##user-variables-with-sample-values).
3. At least 10G available RAM to run everything.


Start up:

```
./compose.sh -f deploy_single_host.yaml up deploy 
```
There is also a [split hosted](./documentation/docs/deployment/SplitHost.md) deployment option. If by any change anyone is interested, please have a read about it.

# Documentation
Full documentation is in the "documentation" folder, which contains a docusaurus code.

It sould be rendered by GitHub but you can also host it yourself with

```
./compose.sh -f documentation.yaml up 
```






