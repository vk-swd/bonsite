import express from "express";
import { createHandler } from "graphql-http/lib/use/express";
import { Query, schema } from "./schema.js";
import { Deferred } from "../common/utils.js";

type GqlServerConfig = {
    port: number,
    url: string,
    generatorAddress: string,
    statementGeneratorAddr: string
}
export class GqlServer {
    static create(config: GqlServerConfig): Promise<GqlServer> {
        const deferred = new Deferred<GqlServer>();
        const app = express();
        const gqlServer = new GqlServer(app);
        app.all(
            config.url,
            createHandler({
                schema,
                rootValue: Query(config.generatorAddress, config.statementGeneratorAddr)
            })
        );
        app.listen(config.port, () => {
            deferred.resolve(gqlServer);
        });
        return deferred.promise;
    }
    private constructor(public app: express.Express) {

    }
}

