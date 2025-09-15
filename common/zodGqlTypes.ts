import * as z from "zod";

export function getString() {
    const validator = z.string()
    return validator.register(z.globalRegistry, { description: "String!" });
}

export function getInt() {
    const validator = z.number();
    return validator.register(z.globalRegistry, { description: "Int!" });
}

export function getIntOptional() {
    const validator = z.number().optional();
    return validator.register(z.globalRegistry, { description: "Int" });
}

export function getEnum<T extends z.util.EnumLike>(enm: T, typeName: "String" | "Int") {
    const validator = z.enum(enm);
    return validator.register(z.globalRegistry, { description: typeName + "!"} );
}

export function getEnumOptional<T extends z.util.EnumLike>(enm: T, typeName: "String" | "Int") {
    const validator = z.enum(enm).optional();
    return validator.register(z.globalRegistry, { description: typeName } );
}