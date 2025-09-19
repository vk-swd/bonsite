import z, { util, ZodObject, ZodRawShape, ZodType } from "zod";
import { StatementParametersValidator, UserDataRequestValidator, UserDataResultValidator } from "./event_types.js";
import { GenParametersValidator, PostTransactionValidator, ProgressReportValidator } from "./generator_parameters.js";
import { logger } from "./logger.js";


function createEnumSchema(enumObject: util.EnumLike) {
    const values = Object.values(enumObject);
    const hasNumbers = values.some(v => typeof v === 'number');
    if (hasNumbers) {
        return z.coerce.number().pipe(z.enum(enumObject) as any);
    } else {
        return z.enum(enumObject);
    }
}
function createGqlSchema<T extends z.ZodTypeAny>(schema: T): z.ZodTypeAny {
    if (schema instanceof z.ZodNumber) {
        return z.coerce.number();
    }
    if (schema instanceof z.ZodEnum) {
        logger.log("Enum schema:", schema.enum, typeof(schema.enum));
        return createEnumSchema(schema.enum) //z.enum(schema.enum);
    }
    if (schema instanceof z.ZodOptional) {
        return createGqlSchema((schema as z.ZodOptional).def.innerType as any).optional();
    }
    if (schema instanceof z.ZodNullable) {
        return createGqlSchema((schema as z.ZodNullable).def.innerType as any).nullable();
    }
    if (schema instanceof z.ZodObject) {
        const newShape = {} as any;
        for (const [key, field] of Object.entries(schema.shape)) {
            newShape[key] = createGqlSchema(field);
        }
        return z.object(newShape);
    }
    if (schema instanceof z.ZodArray) {
        return z.array(createGqlSchema((schema as z.ZodArray).def.element as any));
    }
    return schema; // Return as-is for other types
}

export function parseReturnNames<T>(name: string, o: ZodType<T>): string {
    const lineFirst = name;
    let lineSecond = "";
    if (o.type == "object") {
        const shape = (o as ZodObject).shape
        lineSecond = `{ ${ Object.entries(shape).map(([key, value]) => 
            parseReturnNames(key, value)).join(" ")} }`;
    } else if (o.type == "array") {
        lineSecond = parseReturnNames("", (o as any).element)
    }
    return lineFirst + " " + lineSecond;
}

export function getTypeDeclaration<T extends z.ZodRawShape>(val: z.ZodObject<T>): string {
    const shape = val.shape;
    return `${val.meta()?.description} {\n${Object.entries(shape).map(([key, value]) => 
        `${key}: ${getTypeName(value as z.ZodTypeAny)}`).join("\n")}\n}`;
}
export function getTypeName(val: z.ZodTypeAny): string {
    switch (val.type) {
        case "string": return "String";
        case "number": return "String"; // <================ use String for 64-bit int
        case "boolean": return "Boolean";
        case "object": return val.meta()?.description!;
        case "array": {
            return `[${getTypeName((val as z.ZodArray<z.ZodTypeAny>).element)}]`;
        }
        default: return "String";
    }
}
export type GqlIfy<T> = T extends Object ? {
    [K in keyof T]: T[K] extends number | undefined ? string : GqlIfy<T[K]>
} : T extends number ? string : T;

class GqlFunction1<T, K> {
    declarationStr: string;
    queryStr: string;
    coercedReturnType: ZodType<T>;
    coercedParamType?: ZodType<K>;
    constructor(public name: string, 
        public returnType: ZodType<T>, 
        public paramType?: ZodType<K>) {
        this.coercedReturnType = createGqlSchema(returnType) as ZodType<T>;
        let paramString = "";
        if (paramType) {
            if (paramType.type === "object") {
                paramString = `(params: ${getTypeName(paramType)}!)`;
            }
            this.coercedParamType = createGqlSchema(paramType) as ZodType<K>;
        }
        let returnString = getTypeName(returnType);
        this.declarationStr = `${this.name}${paramString} :${returnString}`;


        this.queryStr = `query `
        if (paramType) {
            this.queryStr += `($input: ${getTypeName(paramType)}!)`
        }
        this.queryStr += ` { ${this.name}`;
        if (paramType) {
            this.queryStr += `(params: $input)`;
        }
        this.queryStr += parseReturnNames("", returnType);
        this.queryStr += ` }`;
    }
    declaration(): string {
        return this.declarationStr + `\n`;
    }
    gqlCall(): string {
        return this.queryStr;
    }
    async fetchCall(url: string, params?: z.infer<typeof this.paramType>): Promise<z.infer<typeof this.coercedReturnType>> {
        const postData = this.gqlCall();
        const variables = params ? { input: params } : undefined;
        const body = JSON.stringify({query: postData, variables}, (key: string, value: any) => {
            // convert numbers to strings for 64-bit int compatibility
            if (typeof value === 'number') {
                return value.toString();
            }
            return value;
        });
        try {
            const rewRes = await fetch(url, { method: "POST", 
                headers: { 'Content-Type': 'application/json' }, 
                body })
            .catch(e => { throw new Error(`Error in fetch: ${e}`); });
            if (!rewRes.ok) {
                const text = await rewRes.text();
                throw new Error(`Bad req status: ${text} ${rewRes.statusText}`);
            }
            const raw = await rewRes.json() as any
            if (raw.errors) {
                throw new Error(`GQL error: ${JSON.stringify(raw.errors)}`);
            }
            logger.log(`GQL raw result:`, raw);
            return this.coercedReturnType.parse(raw.data[this.name]);
        } catch (e) {
            throw new Error(`Error in ${url} request ${body}:  ${e}`);
        }
    }
}

export const postTransaction = new GqlFunction1("postTransaction", z.string(), PostTransactionValidator);
export const startGen = new GqlFunction1("startGen", z.string(), GenParametersValidator);
export const getStatement = new GqlFunction1("getStatement", z.string(), StatementParametersValidator);
export const getProgress = new GqlFunction1("getProgress", ProgressReportValidator);
export const getGeneratorStats = new GqlFunction1("getGeneratorStats", z.string());
export const stopGen = new GqlFunction1("stopGen", z.string());
export const hello = new GqlFunction1("hello", z.string())
export const users = new GqlFunction1("users", UserDataResultValidator, UserDataRequestValidator);
