


See the [Split Hosting](./deployment/SplitHost) deployment topology description.

Also see [a note at the Deployment section](../deployment#notes-anchor) about why I didn't use docker swarm to connect remote servers.


Used to represent a [Grapph QL Server](./deployment/SplitHost.md) in the [Split Hosting](./deployment/SplitHost.md) deployment topology and it is deployed to expect requests from an [SSH Client](./services/OpenSSHClient.md) from the backend to set up the local tunneling server addressed by [Nginx](./services/Nginx.md)