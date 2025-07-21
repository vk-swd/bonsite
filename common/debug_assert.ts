
export let debugAssert: (test: () => boolean, message: string) => void = (test, message) =>{
    if (!test()) {
        throw new Error(`Debug assertion failed: ${message}`);
    }
}