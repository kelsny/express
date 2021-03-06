/* Thanks https://github.com/pillarjs/path-to-regexp! */

interface LexToken {
    type: "OPEN" | "CLOSE" | "PATTERN" | "NAME" | "CHAR" | "ESCAPED_CHAR" | "MODIFIER" | "END";
    index: number;
    value: string;
}

function lexer(str: string): LexToken[] {
    const tokens: LexToken[] = [];
    let i = 0;

    while (i < str.length) {
        const char = str[i];

        if (char === "*" || char === "+" || char === "?") {
            tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
            continue;
        }

        if (char === "\\") {
            tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
            continue;
        }

        if (char === "{") {
            tokens.push({ type: "OPEN", index: i, value: str[i++] });
            continue;
        }

        if (char === "}") {
            tokens.push({ type: "CLOSE", index: i, value: str[i++] });
            continue;
        }

        if (char === ":") {
            let name = "";
            let j = i + 1;

            while (j < str.length) {
                const code = str.charCodeAt(j);

                if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95) {
                    name += str[j++];
                    continue;
                }

                break;
            }

            if (!name) throw new TypeError(`Missing parameter name at ${i}`);

            tokens.push({ type: "NAME", index: i, value: name });
            i = j;
            continue;
        }

        if (char === "(") {
            let count = 1;
            let pattern = "";
            let j = i + 1;

            if (str[j] === "?") {
                throw new TypeError(`Pattern cannot start with "?" at ${j}`);
            }

            while (j < str.length) {
                if (str[j] === "\\") {
                    pattern += str[j++] + str[j++];
                    continue;
                }

                if (str[j] === ")") {
                    count--;
                    if (count === 0) {
                        j++;
                        break;
                    }
                } else if (str[j] === "(") {
                    count++;
                    if (str[j + 1] !== "?") {
                        throw new TypeError(`Capturing groups are not allowed at ${j}`);
                    }
                }

                pattern += str[j++];
            }

            if (count) throw new TypeError(`Unbalanced pattern at ${i}`);
            if (!pattern) throw new TypeError(`Missing pattern at ${i}`);

            tokens.push({ type: "PATTERN", index: i, value: pattern });
            i = j;
            continue;
        }

        tokens.push({ type: "CHAR", index: i, value: str[i++] });
    }

    tokens.push({ type: "END", index: i, value: "" });

    return tokens;
}

interface ParseOptions {
    delimiter?: string;
    prefixes?: string;
}

function parse(str: string, options: ParseOptions = {}): Token[] {
    const tokens = lexer(str);

    const prefixes = options.prefixes ?? "./";

    const defaultPattern = `[^${escapeString(options.delimiter || "/#?")}]+?`;
    const result: Token[] = [];
    let key = 0;
    let i = 0;
    let path = "";

    const tryConsume = (type: LexToken["type"]): string | undefined => (i < tokens.length && tokens[i].type === type ? tokens[i++].value : undefined);

    const mustConsume = (type: LexToken["type"]): string => {
        const value = tryConsume(type);
        if (value !== undefined) return value;
        const nextType = tokens[i].type;
        const index = tokens[i].index;
        throw new TypeError(`Unexpected ${nextType} at ${index}, expected ${type}`);
    };

    const consumeText = (): string => {
        let result = "";
        let value: string | undefined;

        while ((value = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR"))) result += value;

        return result;
    };

    while (i < tokens.length) {
        const char = tryConsume("CHAR");
        const name = tryConsume("NAME");
        const pattern = tryConsume("PATTERN");

        if (name || pattern) {
            let prefix = char || "";

            if (prefixes.indexOf(prefix) === -1) {
                path += prefix;
                prefix = "";
            }

            if (path) {
                result.push(path);
                path = "";
            }

            result.push({
                name: name || key++,
                prefix,
                suffix: "",
                pattern: pattern || defaultPattern,
                modifier: tryConsume("MODIFIER") || "",
            });
            continue;
        }

        const value = char || tryConsume("ESCAPED_CHAR");

        if (value) {
            path += value;
            continue;
        }

        if (path) {
            result.push(path);
            path = "";
        }

        const open = tryConsume("OPEN");

        if (open) {
            const prefix = consumeText();
            const name = tryConsume("NAME") || "";
            const pattern = tryConsume("PATTERN") || "";
            const suffix = consumeText();

            mustConsume("CLOSE");

            result.push({
                name: name || (pattern ? key++ : ""),
                pattern: name && !pattern ? defaultPattern : pattern,
                prefix,
                suffix,
                modifier: tryConsume("MODIFIER") || "",
            });
            continue;
        }

        mustConsume("END");
    }

    return result;
}

interface TokensToFunctionOptions {
    sensitive?: boolean;
    encode?: (value: string, token: Key) => string;
    validate?: boolean;
}

function compile<P extends object = object>(str: string, options?: ParseOptions & TokensToFunctionOptions) {
    return tokensToFunction<P>(parse(str, options), options);
}

type PathFunction<P extends object = object> = (data?: P) => string;

function tokensToFunction<P extends object = object>(tokens: Token[], options: TokensToFunctionOptions = {}): PathFunction<P> {
    const reFlags = flags(options);
    const encode = options.encode ?? ((x: string) => x);
    const validate = options.validate ?? true;

    const matches = tokens.map((token) => (typeof token === "object" ? new RegExp(`^(?:${token.pattern})$`, reFlags) : undefined));

    return (data: Record<string, any> | null | undefined) => {
        let path = "";

        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];

            if (typeof token === "string") {
                path += token;
                continue;
            }

            const value = data ? data[token.name] : undefined;
            const optional = token.modifier === "?" || token.modifier === "*";
            const repeat = token.modifier === "*" || token.modifier === "+";

            if (Array.isArray(value)) {
                if (!repeat) {
                    throw new TypeError(`Expected "${token.name}" to not repeat, but got an array`);
                }

                if (value.length === 0) {
                    if (optional) continue;

                    throw new TypeError(`Expected "${token.name}" to not be empty`);
                }

                for (let j = 0; j < value.length; j++) {
                    const segment = encode(value[j], token);

                    if (validate && !(matches[i] as RegExp).test(segment)) {
                        throw new TypeError(`Expected all "${token.name}" to match "${token.pattern}", but got "${segment}"`);
                    }

                    path += token.prefix + segment + token.suffix;
                }

                continue;
            }

            if (typeof value === "string" || typeof value === "number") {
                const segment = encode(String(value), token);

                if (validate && !(matches[i] as RegExp).test(segment)) {
                    throw new TypeError(`Expected "${token.name}" to match "${token.pattern}", but got "${segment}"`);
                }

                path += token.prefix + segment + token.suffix;
                continue;
            }

            if (optional) continue;

            const typeOfMessage = repeat ? "an array" : "a string";
            throw new TypeError(`Expected "${token.name}" to be ${typeOfMessage}`);
        }

        return path;
    };
}

interface RegexpToFunctionOptions {
    decode?: (value: string, token: Key) => string;
}

interface MatchResult<P extends object = object> {
    path: string;
    index: number;
    params: P;
}

type Match<P extends object = object> = false | MatchResult<P>;

type MatchFunction<P extends object = object> = (path: string) => Match<P>;

function regexpToFunction<P extends object = object>(re: RegExp, keys: Key[], options: RegexpToFunctionOptions = {}): MatchFunction<P> {
    const decode = options.decode ?? ((x: string) => x);

    return function (pathname: string) {
        const m = re.exec(pathname);
        if (!m) return false;

        const path = m[0];
        const index = m.index;
        const params = Object.create(null);

        for (let i = 1; i < m.length; i++) {
            if (m[i] === undefined) continue;

            const key = keys[i - 1];

            if (key.modifier === "*" || key.modifier === "+") {
                params[key.name] = m[i].split(key.prefix + key.suffix).map((value) => {
                    return decode(value, key);
                });
            } else {
                params[key.name] = decode(m[i], key);
            }
        }

        return { path, index, params };
    };
}

function escapeString(str: string) {
    return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}

function flags(options?: { sensitive?: boolean }) {
    return options && options.sensitive ? "" : "i";
}

interface Key {
    name: string | number;
    prefix: string;
    suffix: string;
    pattern: string;
    modifier: string;
}

type Token = string | Key;

function regexpToRegexp(path: RegExp, keys?: Key[]): RegExp {
    if (!keys) return path;

    const groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;

    let index = 0;
    let execResult = groupsRegex.exec(path.source);
    while (execResult) {
        keys.push({
            name: execResult[1] || index++,
            prefix: "",
            suffix: "",
            modifier: "",
            pattern: "",
        });
        execResult = groupsRegex.exec(path.source);
    }

    return path;
}

function arrayToRegexp(paths: Array<string | RegExp>, keys?: Key[], options?: TokensToRegexpOptions & ParseOptions): RegExp {
    const parts = paths.map((path) => pathToRegexp(path, keys, options).source);
    return new RegExp(`(?:${parts.join("|")})`, flags(options));
}

function stringToRegexp(path: string, keys?: Key[], options?: TokensToRegexpOptions & ParseOptions) {
    return tokensToRegexp(parse(path, options), keys, options);
}

interface TokensToRegexpOptions {
    sensitive?: boolean;
    strict?: boolean;
    end?: boolean;
    start?: boolean;
    delimiter?: string;
    endsWith?: string;
    encode?: (value: string) => string;
}

function tokensToRegexp(tokens: Token[], keys?: Key[], options: TokensToRegexpOptions = {}) {
    const encode = options.encode ?? ((x: string) => x);
    const strict = options.strict ?? false;
    const end = options.end ?? true;
    const start = options.start ?? true;

    const endsWith = `[${escapeString(options.endsWith || "")}]|$`;
    const delimiter = `[${escapeString(options.delimiter || "/#?")}]`;
    let route = start ? "^" : "";

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        if (typeof token === "string") {
            route += escapeString(encode(token));
        } else {
            const prefix = escapeString(encode(token.prefix));
            const suffix = escapeString(encode(token.suffix));

            if (token.pattern) {
                if (keys) keys.push(token);

                if (prefix || suffix) {
                    if (token.modifier === "+" || token.modifier === "*") {
                        const mod = token.modifier === "*" ? "?" : "";
                        route += `(?:${prefix}((?:${token.pattern})(?:${suffix}${prefix}(?:${token.pattern}))*)${suffix})${mod}`;
                    } else {
                        route += `(?:${prefix}(${token.pattern})${suffix})${token.modifier}`;
                    }
                } else {
                    route += `(${token.pattern})${token.modifier}`;
                }
            } else {
                route += `(?:${prefix}${suffix})${token.modifier}`;
            }
        }
    }

    if (end) {
        if (!strict) route += `${delimiter}?`;

        route += !options.endsWith ? "$" : `(?=${endsWith})`;
    } else {
        const endToken = tokens[tokens.length - 1];
        const isEndDelimited = typeof endToken === "string" ? delimiter.indexOf(endToken[endToken.length - 1]) > -1 : endToken === undefined;

        if (!strict) {
            route += `(?:${delimiter}(?=${endsWith}))?`;
        }

        if (!isEndDelimited) {
            route += `(?=${delimiter}|${endsWith})`;
        }
    }

    return new RegExp(route, flags(options));
}

type Path = string | RegExp | Array<string | RegExp>;

function pathToRegexp(path: Path, keys?: Key[], options?: TokensToRegexpOptions & ParseOptions) {
    if (path instanceof RegExp) return regexpToRegexp(path, keys);
    if (Array.isArray(path)) return arrayToRegexp(path, keys, options);
    return stringToRegexp(path, keys, options);
}

export default function match<P extends object = object>(str: Path, options?: ParseOptions & TokensToRegexpOptions & RegexpToFunctionOptions) {
    const keys: Key[] = [];
    const re = pathToRegexp(str, keys, options);
    return regexpToFunction<P>(re, keys, options);
}
