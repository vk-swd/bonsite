
import { EnumLike, z, ZodObject, ZodRawShape } from "zod";


export function getString() {
    const validator = z.string()
    return validator.describe("String!");
}

export function getInt() {
    const validator = z.number();
    return validator.describe("Int!");
}

export function getIntOptional() {
    const validator = z.number().optional();
    return validator.describe("Int");
}

export function getEnum<T extends EnumLike>(enm: T, typeName: "String" | "Int") {
    const validator = z.nativeEnum(enm);
    return validator.describe(typeName + "!");
}

export function getEnumOptional<T extends EnumLike>(enm: T, typeName: "String" | "Int") {
    const validator = z.nativeEnum(enm).optional();
    return validator.describe(typeName);
}