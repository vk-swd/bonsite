const run = require("./go").run

setInterval(() => {
    run().catch(console.error)
}, 4000)

console.log('Hello World!');