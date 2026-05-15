export const normalizePath = (p: string) => {
    const parsed = p.replace(/\\+/g, '\\')   
        .trim()
        .toLowerCase();
    return parsed;
}
