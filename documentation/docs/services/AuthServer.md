---
title: Authentication Server
sidebar_label: Authentication Server
---

A service that handles request validation using https://nginx.org/en/docs/http/ngx_http_auth_request_module.html module from [Nginx](./Nginx.md)

### Why was it needed:

1. Restrict access for (my) personal information
2. Implement a minimal rate limiting for web hosting - limiting by sessions is simpler and more precise then by ip and/or user metadata
3. I wanted to see what OpenID is

### Session control

Using [express-sessions](https://www.npmjs.com/package/express-session) 

### Rate limiting

Trivial use of [express-rate-limit](https://www.npmjs.com/package/express-rate-limit). 

The rate is limited using a "x-client-id" header assigned by a web browser. Didn't use IP since many users might have same IP. Also filter bots as they dont load and run web app so header would be empty. It is a naive defense measure that is easy to fake and by no means a substitute for proper DDOS protection, but I kept it as an improvised layer of defense.

### Logging in:

To log in the user needs to:
1. Pass [Turnstile](https://www.cloudflare.com/en-gb/application-services/products/turnstile/) - it is something I was curios to try and it was intended to block the bots and automated scrapers.
2. Provide credentials - there are two types:
    1. Password - the simplest one available. Since no accounts were implemented and resources are shared I didn't implement any hashing or storage - just keep it as env variable.
    2. Google OpenID - implemented 

### Security

To improve security the following things were taken into account:
1. Cookies are configured to be secure and httpOnly
2. Input is sanitized (see [Types and Schemas](../architecture/TypesAndSchemas.md))
3. Restrictive CSP for both login and main app
4. Actions are are logged per IP.
5. Auto login redirect on session expiry