

See the [Split Hosting](./deployment/SplitHost) deployment topology description.


Also see [a note at the Deployment section](../deployment#notes-anchor) about why I didn't use docker swarm to connect remote servers.

An autossh service connecting to the [SSH Server](./services/SSHServer) near [Nginx](./services/Nginx) and expose local [Grapph QL Server](./deployment/SplitHost). 

