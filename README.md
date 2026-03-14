
# BonSite

This is an application made to explore GraphQL, Kafka and SQL Server.

It consists of services described in  [Services](./services/index.md) and its goal is to build a functional pipeline where events are posted  to a shared message queue and then stored persistently


🔗 Live Demo: https://bonsite.org

📝 Login: user / genericPublicPassword (or feel free to use OpenID if you don't mind me seeing your email =))


# Installation
The application was meant to be run with docker, so you will need;

1. Docker
2. Python
3. A file with environment variables. The file must be assigned to the "BONSITE_USER_ENV". This variable is mantioned in the [start up script](./deploy.py) and it must contain the variables described in [documentation](documentation/docs/deployment/index##user-variables-with-sample-values).
4. At least 10G available RAM to run everything. Or disregard that if you want to [split host](./documentation/docs/deployment/SplitHost.md) frontend half with or without authentication.



Start up everything without authentication:
```
BONSITE_USER_ENV=your_env_file ./deploy.py --no-auth up -d
```
There is also a [split hosted](./documentation/docs/deployment/SplitHost.md) deployment option. If by any change anyone is interested, please have a read about it.

Also please run 
```
./deploy.py --help
```
for more information about deployment options

# Documentation
Full documentation is in the "documentation" folder, which contains a docusaurus code.

It sould be rendered by GitHub but you can also host it yourself with

```
./spawn_docs.py
```






