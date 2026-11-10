/** Where to go after sign-in. Only a path on this site: `//host` and `/\\host` are other origins to a browser. */
export const safeNext = (value: string | null): string => value && /^\/(?![/\\])/.test(value) ? value : '/';
