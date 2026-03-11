import z, { util, ZodObject, ZodRawShape, ZodType } from "zod";
import { ServerStateValidator, StatementParameters, StatementParametersValidator, StatementRequestResult, StatementRequestResultValidator, UserDataRequestValidator, UserDataResultValidator, UserDateRangeValidator } from "./event_types.js";
import { GenParametersValidator, PostTransactionValidator, ProgressReportValidator } from "./generator_parameters.js";
import { logger } from "./logger.js";


export const GQL_URL = "/graphql";
function createEnumSchema(enumObject: util.EnumLike, coerceStringToInt: boolean = true) {
    const values = Object.values(enumObject);
    const hasNumbers = values.some(v => typeof v === 'number');
    if (hasNumbers) {
        return (coerceStringToInt ? z.coerce.number() : z.number()).pipe(z.enum(enumObject) as any);
    } else {
        return z.enum(enumObject);
    }
}
function duplicateZodType<T extends z.ZodTypeAny>(schema: T, coerceStringToInt: boolean = true): z.ZodTypeAny {
    // Creates coerced types which force convert strings into numbers where numbers are expected
    if (schema instanceof z.ZodNumber) {
        return coerceStringToInt ? z.coerce.number() : z.number();
    }
    if (schema instanceof z.ZodEnum) {
        return createEnumSchema(schema.enum) //z.enum(schema.enum);
    }
    if (schema instanceof z.ZodOptional) {
        return duplicateZodType((schema as z.ZodOptional).def.innerType as any).optional();
    }
    if (schema instanceof z.ZodNullable) {
        return duplicateZodType((schema as z.ZodNullable).def.innerType as any).nullable();
    }
    if (schema instanceof z.ZodObject) {
        const newShape = {} as any;
        for (const [key, field] of Object.entries(schema.shape)) {
            newShape[key] = duplicateZodType(field);
        }
        return z.object(newShape);
    }
    if (schema instanceof z.ZodArray) {
        return z.array(duplicateZodType((schema as z.ZodArray).def.element as any));
    }
    return schema; // Return as-is for other types
}
export function makeNamedZodType<T extends z.ZodRawShape>(schema: z.ZodObject<T>, name: string): z.ZodObject<T> {
    // TODO: tighen up the procedure here to make sure that no modification of the shape is possible
    return duplicateZodType(schema, false).register(z.globalRegistry, { description: name }) as z.ZodObject<T>;
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

export function getTypeDeclaration<T extends z.ZodRawShape>(val: z.ZodObject<T>, prefix?: string): string {
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
export const customHeaderParamClientId = "x-client-id";
export enum ApiErrorType {
    NONE = 0,
    INVALID_LOGIN = 1,
    SERVER_ERROR = 2,
    INVALID_STATEMENT_REQUEST = 3,
    INVALID_TRANSACTION = 4,
    INVALID_GENERATOR_PARAMETERS = 5,
    GENERATOR_BUSY = 6,
    NOT_AUTHENTICATED = 7,
    SESSION_EXPIRED = 8,
    INVALID_TOKEN = 9,
    TOO_MANY_REQUESTS = 10,
    NOT_REACHABLE = 11,
    RATE_LIMITED = 12
}
export class ApiError extends Error {
    constructor(message: string, public type: ApiErrorType = ApiErrorType.SERVER_ERROR, public prevError?: any) {
        super(message);
        this.name = "ApiError";
    }
    static reconstruct(obj: any): ApiError | any {
        if (obj && obj.name == "ApiError") {
            const prev = ApiError.reconstruct(obj.prevError)??obj.prevError;
            const err = new ApiError(obj.message, obj.type, prev);
            err.stack = obj.stack;
            err.cause = obj.cause;
            return err;
        }
        return obj;
    }
    toJSON() {
        return {
            name: this.name,
            message: this.message,
            type: this.type,
            prevError: this.prevError,
            stack: this.stack,
            cause: this.cause
        };
    }
}
class GqlFunction1<T, K> {
    declarationStr: string;
    queryStr: string;
    //Coerced types force convert strings into numbers where numbers are expected
    coercedReturnType: ZodType<T>;
    coercedParamType?: ZodType<K>;
    constructor(public name: string,
        public returnType: ZodType<T>,
        public paramType?: ZodType<K>) {
        this.coercedReturnType = duplicateZodType(returnType) as ZodType<T>;
        let paramString = "";
        if (paramType) {
            if (paramType.type === "object") {
                paramString = `(params: ${getTypeName(paramType)}!)`;
            }
            this.coercedParamType = duplicateZodType(paramType) as ZodType<K>;
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
    async fetchCall(url: string, params?: z.infer<typeof this.paramType>, clientId?: string): Promise<T> {
        const postData = this.gqlCall();
        const variables = params ? { input: params } : undefined;
        const body = JSON.stringify({query: postData, variables}, (key: string, value: any) => {
            // convert numbers to strings for 64-bit int compatibility
            if (typeof value === 'number') {
                return value.toString();
            }
            return value;
        });
        const headers = { 'Content-Type': 'application/json',
            ...(clientId ? {[customHeaderParamClientId]: clientId} : {})
        }
        try {
            const rewRes = await fetch(url, { method: "POST",
                headers,
                body })
            .catch(e => { throw new ApiError(`Error in fetch: ${e}`, ApiErrorType.SERVER_ERROR, e); });
            if (!rewRes.ok) {
                const eMessage = `Bad req status: ${rewRes.status} - ${rewRes.statusText}`;
                if (rewRes.status == 401) {
                    throw new ApiError(eMessage, ApiErrorType.NOT_AUTHENTICATED);
                }
                if (rewRes.status == 502) {
                    throw new ApiError(eMessage, ApiErrorType.NOT_REACHABLE);
                }
                const contentType = rewRes.headers.get("content-type");
                if (contentType && contentType.includes("application/json")) {
                    const data = ApiError.reconstruct(await rewRes.json());
                    throw new ApiError(eMessage + ", json.", ApiErrorType.SERVER_ERROR, data);
                } else {
                    const text = await rewRes.text();
                    throw new ApiError(eMessage + ", text.", ApiErrorType.SERVER_ERROR, text);
                }
            }
            const raw = await rewRes.json() as any
            if (raw.errors) {
                throw new ApiError(`GQL error: ${JSON.stringify(raw.errors)}`, ApiErrorType.SERVER_ERROR, raw.errors);
            }
            return this.coercedReturnType.parse(raw.data[this.name]);
        } catch (e) {
            throw new ApiError(`Error in ${url} request ${body}:  ${e}`, ApiErrorType.SERVER_ERROR, e);
        }
    }
}

export const postTransaction = new GqlFunction1("postTransaction", z.string(), 
    makeNamedZodType(PostTransactionValidator, "PostTransactionParameters"));
export const startGen = new GqlFunction1("startGen", z.string(), 
    makeNamedZodType(GenParametersValidator, "GeneratorParameters"))
export const getProgress = new GqlFunction1("getProgress", 
    makeNamedZodType(ProgressReportValidator, "ProgressReport"));

export const getGeneratorStats = new GqlFunction1("getGeneratorStats", z.string());
export const stopGen = new GqlFunction1("stopGen", z.string());
export const hello = new GqlFunction1("hello", z.string())

const UserDataResultNamedZod: z.ZodObject = makeNamedZodType(UserDataResultValidator, "UserDataResult") as z.ZodObject<any>; 
export const UserDataNamedZod = (UserDataResultNamedZod.shape.slice as z.ZodArray<any>).element.register(z.globalRegistry, { description: "UserData" }) as z.ZodObject<any>;
export const users = new GqlFunction1("users", 
    UserDataResultNamedZod, 
    makeNamedZodType(UserDataRequestValidator, "UserDataRequest"));

export const getDatabaseStats = new GqlFunction1("getDatabaseStats", 
    makeNamedZodType(ServerStateValidator, "ServerState"));

const StatementReqResNamedZod = makeNamedZodType(StatementRequestResultValidator, "StatementRecords") as z.ZodObject;
export const TransactionNamedZod = StatementReqResNamedZod.shape.transactions.element.register(z.globalRegistry, { description: "Transaction" }) as z.ZodObject<any>;
export const getStatement = new GqlFunction1<z.infer<typeof StatementReqResNamedZod>, StatementParameters>("getStatement",
    StatementReqResNamedZod, 
    makeNamedZodType(StatementParametersValidator, "StatementParameters"));

export const getTransactionDatesForUser = new GqlFunction1("getTransactionDatesForUser",
    makeNamedZodType(UserDateRangeValidator, "UserDateRangeRequest"),
    makeNamedZodType(UserDateRangeValidator, "UserDateRangeResponse"));

