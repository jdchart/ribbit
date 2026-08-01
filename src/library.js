// Talking to the host's static library.
//
// The engine ships no audio and no patterns of its own — it reads whatever the
// host serves under /samples/ and /patterns/ (see samples.js and pattern.js,
// the two consumers). Both need exactly the same three things, and each used
// to carry its own copy: a URL builder, a JSON fetch, and a cache that has to
// hold both a promise and its resolved value. This is that layer, once.
//
// The URL builder in particular was worth un-duplicating: the copies had
// already drifted, and the version that hadn't been fixed 404s on any filename
// containing a comma.

// Characters encodeURIComponent escapes that are in fact legal inside a URL
// path segment (RFC 3986 sub-delims, plus ":" and "@"). They have to be put
// back: a static file server matches the raw path, so an escaped one is simply
// a different, nonexistent filename. The comma is the one that bites in
// practice — "Cala Llombards, Sea Urchins.wav" is served fine literally and
// 404s as "%2C", which stays invisible until a library contains a filename
// with one. (Drum samples never did; field recordings do.)
//
// The general rule this encodes: encodeURIComponent is for query values, not
// path segments.
const LEGAL_IN_PATH = { "%2C": ",", "%3A": ":", "%40": "@", "%24": "$", "%26": "&", "%2B": "+", "%3B": ";", "%3D": "=" };

// The fetchable URL for a library-relative path ("foley/river.wav",
// "hiphopdrums/boom-bap.json"). Each segment is encoded individually —
// encodeURIComponent on the whole string would eat the "/" separating folder
// from filename — and library filenames routinely contain spaces, so encoding
// of some kind is not optional.
export function libraryUrl(path, base) {
    const segments = String(path).split("/").map((segment) =>
        encodeURIComponent(segment).replace(/%(?:2C|3A|40|24|26|2B|3B|3D)/g, (match) => LEGAL_IN_PATH[match]));
    return `${base}/${segments.join("/")}`;
};

export async function fetchJSON(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
};

// A URL-keyed cache of loaded JSON, in two layers.
//
// The promise layer is the obvious one: a library file is static for the life
// of the page, and several sample-backed tracks constructed together should
// share one request rather than race. The *resolved* layer exists because
// awaiting an already-settled promise still costs a microtask, which is long
// enough for the console to have printed its confirmation line — so a live
// re-roll would echo the sample it just replaced and read as "nothing
// happened". Once a value is in the resolved layer, reading it is fully
// synchronous and the echo is honest.
//
// A failure is never cached: the entry is dropped so a later attempt retries.
// `load` defaults to a plain JSON fetch; a caller whose cached value is
// derived from the response (pattern.js caches the *parsed* pattern, so a
// reseed pays the parse once) passes its own.
export function createLibraryCache() {
    const pending = new Map();
    const resolved = new Map();

    return {
        get(url, load = fetchJSON) {
            if (!pending.has(url)) {
                pending.set(url, Promise.resolve(load(url))
                    .then((value) => {
                        resolved.set(url, value);
                        return value;
                    })
                    .catch((error) => {
                        pending.delete(url);
                        throw error;
                    }));
            }
            return pending.get(url);
        },
        // The synchronous path: whatever has already landed, or null.
        // Callers fall back to get().
        resolved(url) {
            return resolved.get(url) ?? null;
        },
    };
};
