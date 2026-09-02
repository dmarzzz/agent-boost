(() => {
  "use strict";

  const allowed = Object.freeze({
    eth: new Set(["ready", "setup", "off", "attention", "unavailable"]),
    spend: new Set(["ready", "setup", "off", "attention", "unavailable"]),
    zec: new Set(["ready", "setup", "off", "attention", "unavailable"]),
    tor: new Set(["wallet", "setup", "off", "attention", "unavailable"]),
    shade: new Set(["on", "setup", "off", "attention", "unavailable"]),
    think: new Set(["on", "setup", "off", "attention", "unavailable"]),
  });

  const defaults = Object.freeze({
    eth: "ready",
    spend: "ready",
    zec: "ready",
    tor: "wallet",
    shade: "off",
    think: "off",
  });

  function readReportedState() {
    const values = { ...defaults };
    const params = new URLSearchParams(window.location.hash.slice(1));
    const reported = params.get("v") === "1";
    if (reported) {
      for (const [key, accepted] of Object.entries(allowed)) {
        const value = params.get(key);
        if (value !== null && accepted.has(value)) values[key] = value;
      }
    }
    window.history.replaceState(null, "", window.location.pathname);
    return { reported, values };
  }

  const definitions = [
    {
      key: "eth",
      icon: "💳",
      name: "Ethereum test wallet",
      detail: "A disposable wallet for valueless test payments.",
    },
    {
      key: "spend",
      icon: "🕶️",
      name: "Private payment pocket",
      detail: "Hermes can request a bounded payment; policy still decides.",
    },
    {
      key: "zec",
      icon: "🛡️",
      name: "Zcash wallet",
      detail: "A shielded wallet when the selected backend supports it.",
    },
    {
      key: "tor",
      icon: "🧅",
      name: "Wallet traffic",
      detail: "Only wallet RPC traffic uses this route—not all of Hermes.",
    },
    {
      key: "shade",
      icon: "🌳",
      name: "Covered web",
      detail: "Optional public reads through Shade Tree when enabled.",
    },
    {
      key: "think",
      icon: "🧠",
      name: "Private inference",
      detail: "Optional bounded queries through a verified private provider.",
    },
  ];

  const labels = Object.freeze({
    ready: ["Ready", "ready"],
    wallet: ["Through Tor", "ready"],
    on: ["On", "ready"],
    setup: ["Warming up", "working"],
    off: ["Off for now", "off"],
    attention: ["Needs attention", "attention"],
    unavailable: ["Unavailable", "off"],
  });

  const parsed = readReportedState();
  const state = parsed.values;
  if (!parsed.reported) {
    document.querySelector("#reported-label").textContent = "Example loadout";
    document.querySelector("#receipt-kind").textContent = "Example";
  }
  const container = document.querySelector("#capabilities");
  const fragment = document.createDocumentFragment();

  for (const capability of definitions) {
    const value = state[capability.key];
    const [label, tone] = labels[value];
    const row = document.createElement("article");
    row.className = "capability";

    const icon = document.createElement("span");
    icon.className = "capability-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = capability.icon;

    const copy = document.createElement("span");
    copy.className = "capability-copy";
    const name = document.createElement("strong");
    name.textContent = capability.name;
    const detail = document.createElement("small");
    detail.textContent = capability.detail;
    copy.append(name, detail);

    const badge = document.createElement("span");
    badge.className = "state";
    badge.dataset.tone = tone;
    badge.textContent = label;

    row.append(icon, copy, badge);
    fragment.append(row);
  }

  container.replaceChildren(fragment);

  const onion = document.querySelector("#onion-log strong");
  onion.textContent = state.tor === "wallet"
    ? "layers acquired ✓"
    : state.tor === "setup"
      ? "adding layers…"
      : state.tor === "attention"
        ? "needs a little help !"
        : "not taking this route";

  const shade = document.querySelector("#shade-log strong");
  shade.textContent = state.shade === "on"
    ? "leaves deployed ✓"
    : state.shade === "setup"
      ? "growing leaves…"
      : state.shade === "attention"
        ? "needs a little help !"
        : "napping zZz";
})();
