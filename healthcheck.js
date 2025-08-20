
const args = process.argv.slice(2); // everything after `node healthcheck.js`
const port = args[0];
await fetch(`http://localhost:${port}/`)
            .then(res => {
                console.log("Healthcheck response:" + JSON.stringify(res));
                if (!res.ok) {
                    console.error("Healthcheck not ok:" + JSON.stringify(err));
                    process.exit(1);
                }
            })
            .catch(err => {
                console.error("Healthcheck error:" + JSON.stringify(err));
                process.exit(1);
            });
