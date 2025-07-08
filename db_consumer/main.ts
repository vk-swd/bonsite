import { getEnv } from "./common/utils";
import { KClient } from "./common/kafka_client";




const kafka_client = new KClient({ 
    name: getEnv("HOSTNAME"), 
    brokers: [getEnv("KAFKA_BROKER")] 
});

kafka_client.subscribe(getEnv("KAFKA_TOPIC"));
