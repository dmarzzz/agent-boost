const allowedRaw = process.env.AGENT_BOOST_ALLOWED_RPC_URL;
let allowed;
try {
  allowed = new URL(allowedRaw ?? "");
} catch {
  throw new Error("Agent Boost Kohaku network guard requires its loopback RPC URL");
}

if (
  allowed.protocol !== "http:" ||
  allowed.hostname !== "127.0.0.1" ||
  allowed.port === "" ||
  !/^\/rpc\/[A-Za-z0-9_-]{43}$/u.test(allowed.pathname) ||
  allowed.search !== "" ||
  allowed.hash !== ""
) {
  throw new Error("Agent Boost Kohaku network guard rejected its RPC URL");
}

const allowedUrl = allowed.toString();
const nativeFetch = globalThis.fetch.bind(globalThis);

Object.defineProperty(globalThis, "fetch", {
  configurable: false,
  enumerable: true,
  // Pinned Kohaku captures this guarded function as its clearnet transport,
  // then installs its own Tor-aware wrapper on globalThis.fetch. Keep the
  // property writable so that wrapper can compose with the guard; leaving it
  // non-configurable prevents the property itself from being redefined.
  writable: true,
  value(input, init) {
    const requested = typeof input === "string"
      ? new URL(input).toString()
      : input instanceof URL
        ? input.toString()
        : new URL(input.url).toString();
    const destination = new URL(requested);
    const isKohakuLoopback =
      destination.protocol === "http:" &&
      destination.hostname === "127.0.0.1" &&
      destination.port !== "";
    if (requested !== allowedUrl && !isKohakuLoopback) {
      return Promise.reject(new Error("Agent Boost blocked a direct Kohaku network fetch"));
    }
    return nativeFetch(input, init);
  },
});
