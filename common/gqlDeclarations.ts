import z, { ZodObject, ZodRawShape, ZodType } from "zod";
import { StatementParametersValidatorGql, UserDataRequestValidator, UserDataValidator } from "./event_types.js";
import { GenParametersValidatorGql, PostTransactionValidatorGql, ProgressReportValidator } from "./generator_parameters.js";


export function gqlFromZod<T extends ZodRawShape>(validator: ZodObject<T>): string {
    let res = "";
    Object.entries(validator.shape).forEach(([key, value])=> {
        res += `${key}: ${(value as ZodObject<any>).meta()?.description}\n`;
    })
    return res;
}
type FunctionsMap<T extends ZodRawShape> = {
    [k in keyof z.infer<ZodObject<T>>]: (val: z.infer<ZodObject<T>>[k]) => string
}

interface BaseGqlType<T> {
    name(): string
    fields(): string
    queryString(params?: T): string
    validate(data: T): T
    declaration(): string
}

class GqlString implements BaseGqlType<string> {
    constructor() {}
    name(): string {
        return "String";
    }
    fields(): string {
        return "";
    }
    validate(data: string): string {
        return data;
    }
    queryString(params?: string): string {
        return params ? `(\"${params}\")` : "";
    }
    declaration(): string {
        return "";
    }
}

class GqlInt implements BaseGqlType<number> {
    constructor() {}
    name(): string {
        return "Int";
    }
    validate(data: number): number {
        return data;
    }
    fields(): string {
        return "";
    }
    queryString(params?: number): string {
        return params ? `(${params.toFixed(0)})` : "";
    }
    declaration(): string {
        return "";
    }
}
export class GqlType<T extends ZodRawShape> implements BaseGqlType<z.infer<ZodObject<T>>> {
    fieldsRV: string = "";
    requestMaker: FunctionsMap<T>;
    argValue: (params: z.infer<ZodObject<T>>) => string
    name(): string {
        return this._name;
    }
    constructor(public _name: string, public validator: ZodObject<T>, private type: "input" | "type") {
        this.fieldsRV = "{" + Object.keys(validator.shape).join(' ') + "}";
        this.requestMaker = Object.fromEntries(Object.entries(validator.shape).map(([key, value]) => {
            const meta = (value as ZodType<any>).meta()?.description;
            if (meta == "Int" || meta == "Int!") {
                return [key, (val: number) => val.toFixed(0)];
            } else {
                return [key, (val: string) => { 

                console.log(`Using string for ${key} with meta ${meta} fpr val ${val}`);
                    return `\\"${val}\\"`}];
            }}));
        this.argValue = (params: z.infer<ZodObject<T>>): string => {
            return `{ ${Object.keys(this.requestMaker).map((key) =>
                    `${key}: ${Object(this.requestMaker)[key](Object(params)[key])}`).join(", ")} }`;
        }
    }
    validate(data: z.infer<ZodObject<T>>): z.infer<ZodObject<T>> {
        return this.validator.parse(data);
    }
    queryString(params?: z.infer<ZodObject<T>>): string {
        return params ? `${this.argValue(params)}` : "";
    }
    declaration(): string {
        return `${this.type} ${this.name()} {\n${gqlFromZod(this.validator)}}\n`;
    }
    fields(): string {
        return this.fieldsRV;
    }
}

export const ProgressReportGqlType = new GqlType("ProgressReport", ProgressReportValidator, "type");
export const GenParametersGqlType = new GqlType("GenParameters", GenParametersValidatorGql, "input");
export const StatementParametersGqlType = new GqlType("StatementParameters", StatementParametersValidatorGql, "input");
export const PostTransactionParamsGqlType = new GqlType("PostTransactionParams", PostTransactionValidatorGql, "input");
export const UserRecordGqlType = new GqlType("UserRecord", UserDataValidator, "type");
export const UserRequestGqlType = new GqlType("UserRequest", UserDataRequestValidator, "input");

class GqlFunction<T, K> {
    constructor(public name: string, public returnType: BaseGqlType<T>, public paramType?: BaseGqlType<K>) {
    }
    declaration(): string {
        return `${this.name}${this.paramType ? `(params: ${this.paramType.name()}!)` : ""} :${this.returnType.name()}`;
    }
    gqlCall(params?: K): string {
        return `${this.name}${this.paramType ? `(params: ${this.paramType!.queryString(params)})` : ""} ${this.returnType.fields()}`;
    }
    async fetchCall(url: string, params?: K): Promise<T> {
        const body = `{ "query": "{ ${this.gqlCall(params)} }" }`;
        try { 
            const rewRes = await fetch(url, { method: "POST", headers: { 'Content-Type': 'application/json' }, body });
            if (!rewRes.ok) {
                const text = await rewRes.text();
                throw new Error(`Bad req status: ${text}`);
            }
            const raw = await rewRes.json()
            if (raw.errors) {
                throw new Error(`GQL error: ${JSON.stringify(raw.errors)}`);
            }
            return this.returnType.validate(raw.data[this.name]);
        } catch (e) {
            throw new Error(`Error in request ${body}:  ${e}`);
        }
    }
}

export const stopGen = new GqlFunction("stopGen", new GqlString());
export const startGen = new GqlFunction("startGen", new GqlString(), GenParametersGqlType);
export const getProgress = new GqlFunction("getProgress", ProgressReportGqlType);
export const getStatement = new GqlFunction("getStatement", new GqlString(), StatementParametersGqlType);
export const hello = new GqlFunction("hello", new GqlString());
export const users = new GqlFunction("users", UserRecordGqlType, UserRequestGqlType);
export const postTransaction = new GqlFunction("postTransaction", new GqlString(), PostTransactionParamsGqlType);
export const getGeneratorStats = new GqlFunction("getGeneratorStats", new GqlString());