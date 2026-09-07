#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stringify as stringifyYaml } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = JSON.parse(
  await readFile(join(root, "evals", "ideal-flows.json"), "utf8"),
);

export const HERMES_AGENT_BOOST_SYSTEM_PROMPT_BLOCK = [
  "[BEGIN AGENT BOOST MANAGED ROUTING]",
  "Agent Boost wallet rules:",
  "- An unqualified transfer from a named wallet, profile, or main account is regular/public. For an explicit regular/public send from <parent>/<pocket>, put the parent in source and the child in source_private_balance; if only the pocket or its public change is named, use $selected as source and that child name in source_private_balance. It remains regular, not private. The word private inside a saved-wallet friendly name never selects private mode or a child pocket; only an explicit private, shielded, from-private, recovery, or unshield request does. Route mode first: regular/public -> wallet_preview_regular_transfer; private/shielded -> wallet_preview_private_transfer; recovery/private-to-main -> wallet_preview_recovery_transfer. Do this even when the source is named or inactive; never list or load it first. Treat destination names as lookups; never infer wallet creation.",
  "- A private balance is a named child pocket under one saved wallet, not another top-level wallet. Use wallet_preview_private_balance_create to add one, wallet_preview_private_balance_fund to fund one, and the private-balance policy tools for its own limits. For funding, wallet_name is the parent; source=$main means that parent's public account, otherwise source is an exact sibling pocket name. Its nested public-change balance stays under that child and is regular-sendable. Use wallet_get_tree for the overview.",
  "- Any preview or result that asks for approval ends this assistant turn. Continue only after a later actual user turn; all approval happens through that chat reply, never an app, popup, or other confirmation surface. Never manufacture, quote, simulate, or impersonate user input.",
  "- Never put raw tool/function-call syntax (including <function> tags) or internal tool, decision, or request IDs in user-facing text.",
  "- A canonical transfer execution performs one no-rebroadcast verification read itself and returns the final, unresolved, or explicitly unverified state. Do not add another tool call in that assistant turn. A matching wallet_get_*_request tool is only for a later user status request; never execute again to check.",
  "- When the latest trusted Agent Boost result requested a status follow-up, a fresh user message such as check again starts a new read-only turn. Perform exactly one fresh read for that matching setup or unresolved operation; never answer from an older balance, phase, or tree. Repeating a read across user turns is allowed and required. This never permits repeating an execute, apply, create, fund, shield, or broadcast action.",
  "[END AGENT BOOST MANAGED ROUTING]",
].join("\n");

const canonicalWalletTree = [
  "🗂 wallets/",
  "└── 💼 agent-boost/ [active]",
  "\u00a0\u00a0\u00a0\u00a0├── 🌐 main/ — 1.5 Sepolia ETH · live",
  "\u00a0\u00a0\u00a0\u00a0└── 🥷 private/ — 0.25 Sepolia ETH · live",
  "",
  "Folders organize wallet views; they do not imply custody or control.",
].join("\n");

const privateBalanceWalletTree = [
  "🗂 wallets/",
  "├── 💼 agent-boost/ [active]",
  "│\u00a0\u00a0\u00a0├── 🌐 main/ — 1.5 Sepolia ETH · live",
  "│\u00a0\u00a0\u00a0├── 🥷 savings/ — 0.2 Sepolia ETH · live",
  "│\u00a0\u00a0\u00a0│\u00a0\u00a0\u00a0└── 💧 public-change/ — 0.04 Sepolia ETH · live · regular-sendable",
  "│\u00a0\u00a0\u00a0└── 🥷 trips/ — 0.1 Sepolia ETH · live",
  "└── 💼 travel-wallet/",
  "\u00a0\u00a0\u00a0\u00a0├── 🌐 main/ — 0.8 Sepolia ETH · live",
  "\u00a0\u00a0\u00a0\u00a0└── 🥷 reserve/ — 0.1 Sepolia ETH · last known",
  "",
  "Folders organize wallet views; they do not imply custody or control.",
].join("\n");

const hermesSkillNames = [
  "agent-boost-setup",
  "agent-boost",
  "agent-boost-wallet-tree",
  "agent-boost-wallets",
  "agent-boost-policy",
  "agent-boost-transfers",
  "agent-boost-wallet-actions",
  "agent-boost-authorize",
  "agent-boost-confirm",
  "agent-boost-covered-web",
];

const skillSequenceByFlow = {
  "setup-funding-qr": ["agent-boost-setup"],
  "setup-partial-funding": ["agent-boost-setup"],
  "setup-preparing-private-balance": ["agent-boost-setup"],
  "setup-ready": ["agent-boost-setup"],
  "setup-failed": ["agent-boost-setup"],
  "start-new-demo-wallet": ["agent-boost-setup", "agent-boost-wallet-actions"],
  "cancel-new-demo-wallet": ["agent-boost-setup", "agent-boost-wallet-actions"],
  "advanced-setup-shows-live-policy": ["agent-boost-policy"],
  "wallet-tree-without-identifiers": ["agent-boost-wallet-tree"],
  "plain-wallet-overview-uses-tree": ["agent-boost-wallet-tree"],
  "saved-wallet-inventory": ["agent-boost-wallets"],
  "already-active-wallet-needs-no-switch": ["agent-boost-wallets"],
  "ambiguous-old-wallet": ["agent-boost-wallets", "agent-boost-wallets"],
  "load-and-reauthorize-previous-wallet": [
    "agent-boost-wallets",
    "agent-boost-wallet-actions",
    "agent-boost-authorize",
  ],
  "named-source-regular-transfer": [
    "agent-boost-transfers",
    "agent-boost-wallet-actions",
    "agent-boost-authorize",
    "agent-boost-confirm",
  ],
  "current-chat-named-source-regular-transfer": [
    "agent-boost-transfers",
    "agent-boost-wallet-actions",
    "agent-boost-authorize",
    "agent-boost-confirm",
  ],
  "cancel-wallet-switch": ["agent-boost-wallets", "agent-boost-wallet-actions"],
  "adopt-local-wallet": ["agent-boost-wallets", "agent-boost-wallet-actions"],
  "cancel-wallet-adoption": ["agent-boost-wallets", "agent-boost-wallet-actions"],
  "create-named-wallet": ["agent-boost-wallets", "agent-boost-wallet-actions"],
  "cancel-wallet-creation": ["agent-boost-wallets", "agent-boost-wallet-actions"],
  "archive-inactive-wallet": ["agent-boost-wallets", "agent-boost-wallet-actions"],
  "cancel-wallet-archive": ["agent-boost-wallets", "agent-boost-wallet-actions"],
  "ambiguous-amount-clarification": ["agent-boost-transfers"],
  "confirmed-payment-with-emoji": ["agent-boost-transfers", "agent-boost-confirm"],
  "confirmed-regular-transfer": ["agent-boost-transfers", "agent-boost-confirm"],
  "ambiguous-transfer-mode": ["agent-boost-transfers"],
  "regular-transfer-gas-reserve-blocked": ["agent-boost-transfers"],
  "chat-regular-transfer-cancelled": ["agent-boost-transfers", "agent-boost-confirm"],
  "indeterminate-payment-stays-unresolved": ["agent-boost-transfers", "agent-boost-confirm"],
  "chat-payment-cancelled": ["agent-boost-transfers", "agent-boost-confirm"],
  "main-balance-read": ["agent-boost-wallets"],
  "amount-affordability-is-server-computed": ["agent-boost-wallets"],
  "local-deny-override": ["agent-boost-transfers"],
  "local-allow-override": ["agent-boost-transfers"],
  "policy-update-with-confirmation": ["agent-boost-policy", "agent-boost-confirm"],
  "policy-update-cancelled": ["agent-boost-policy", "agent-boost-confirm"],
  "expired-delegation-blocked": ["agent-boost-transfers"],
  "private-balance-create-confirmed": [
    "agent-boost-wallets",
    "agent-boost-confirm",
    "agent-boost-wallet-tree",
  ],
  "private-balance-fund-from-main": ["agent-boost-wallets", "agent-boost-confirm"],
  "private-balance-fund-from-sibling": ["agent-boost-wallets", "agent-boost-confirm"],
  "private-balance-policy-read": ["agent-boost-policy"],
  "private-balance-policy-update-confirmed": ["agent-boost-policy", "agent-boost-confirm"],
  "private-balance-policy-update-cancelled": ["agent-boost-policy", "agent-boost-confirm"],
  "private-balance-public-change-regular-transfer": [
    "agent-boost-transfers",
    "agent-boost-confirm",
  ],
  "confirmed-exact-recovery": ["agent-boost-transfers", "agent-boost-confirm"],
  "chat-recovery-cancelled": ["agent-boost-transfers", "agent-boost-confirm"],
  "covered-public-read": ["agent-boost-covered-web"],
  "covered-read-needs-enrollment": ["agent-boost-covered-web"],
};

const expectedTraces = {
  "setup-funding-qr": ["onboarding_start"],
  "setup-partial-funding": ["onboarding_status"],
  "setup-preparing-private-balance": ["onboarding_status"],
  "setup-ready": ["onboarding_status", "capabilities", "wallet_get_tree"],
  "setup-failed": ["onboarding_status"],
  "start-new-demo-wallet": ["wallet_start_new_demo", "wallet_start_new_demo"],
  "cancel-new-demo-wallet": ["wallet_start_new_demo", "wallet_start_new_demo"],
  "advanced-setup-shows-live-policy": ["wallet_get_policy"],
  "wallet-tree-without-identifiers": ["wallet_get_tree"],
  "plain-wallet-overview-uses-tree": ["wallet_get_tree"],
  "saved-wallet-inventory": ["wallet_list_saved_profiles"],
  "already-active-wallet-needs-no-switch": ["wallet_preview_saved_profile_load"],
  "ambiguous-old-wallet": [
    "wallet_preview_saved_profile_load",
    "wallet_preview_saved_profile_load",
  ],
  "load-and-reauthorize-previous-wallet": [
    "wallet_preview_saved_profile_load",
    "wallet_apply_saved_profile_load",
    "wallet_apply_reauthorization",
  ],
  "named-source-regular-transfer": [
    "wallet_preview_regular_transfer",
    "wallet_apply_saved_profile_load",
    "wallet_apply_reauthorization",
    "wallet_preview_regular_transfer",
    "wallet_execute_regular_transfer",
  ],
  "current-chat-named-source-regular-transfer": [
    "wallet_preview_regular_transfer",
    "wallet_apply_saved_profile_load",
    "wallet_apply_reauthorization",
    "wallet_preview_regular_transfer",
    "wallet_execute_regular_transfer",
  ],
  "cancel-wallet-switch": [
    "wallet_preview_saved_profile_load",
    "wallet_apply_saved_profile_load",
  ],
  "adopt-local-wallet": [
    "wallet_list_saved_profiles",
    "wallet_adopt_existing",
    "wallet_adopt_existing",
  ],
  "cancel-wallet-adoption": [
    "wallet_list_saved_profiles",
    "wallet_adopt_existing",
    "wallet_adopt_existing",
  ],
  "create-named-wallet": ["wallet_create", "wallet_create"],
  "cancel-wallet-creation": ["wallet_create", "wallet_create"],
  "archive-inactive-wallet": [
    "wallet_list_saved_profiles",
    "wallet_archive",
    "wallet_archive",
  ],
  "cancel-wallet-archive": [
    "wallet_list_saved_profiles",
    "wallet_archive",
    "wallet_archive",
  ],
  "ambiguous-amount-clarification": [],
  "confirmed-payment-with-emoji": [
    "wallet_preview_private_transfer",
    "wallet_execute_private_transfer",
  ],
  "confirmed-regular-transfer": [
    "wallet_preview_regular_transfer",
    "wallet_execute_regular_transfer",
  ],
  "ambiguous-transfer-mode": [],
  "regular-transfer-gas-reserve-blocked": ["wallet_preview_regular_transfer"],
  "chat-regular-transfer-cancelled": [
    "wallet_preview_regular_transfer",
    "wallet_execute_regular_transfer",
  ],
  "indeterminate-payment-stays-unresolved": [
    "wallet_preview_private_transfer",
    "wallet_execute_private_transfer",
  ],
  "chat-payment-cancelled": [
    "wallet_preview_private_transfer",
    "wallet_execute_private_transfer",
  ],
  "main-balance-read": ["wallet_get_main_balance"],
  "amount-affordability-is-server-computed": ["wallet_get_main_balance"],
  "local-deny-override": ["wallet_preview_private_transfer"],
  "local-allow-override": [
    "wallet_preview_private_transfer",
    "wallet_execute_private_transfer",
  ],
  "policy-update-with-confirmation": [
    "wallet_plan_policy_update",
    "wallet_apply_policy_update",
  ],
  "policy-update-cancelled": [
    "wallet_plan_policy_update",
    "wallet_apply_policy_update",
  ],
  "expired-delegation-blocked": ["wallet_preview_private_transfer"],
  "private-balance-create-confirmed": [
    "wallet_preview_private_balance_create",
    "wallet_apply_private_balance_create",
    "wallet_get_tree",
  ],
  "private-balance-fund-from-main": [
    "wallet_preview_private_balance_fund",
    "wallet_apply_private_balance_fund",
  ],
  "private-balance-fund-from-sibling": [
    "wallet_preview_private_balance_fund",
    "wallet_apply_private_balance_fund",
  ],
  "private-balance-policy-read": ["wallet_get_private_balance_policy"],
  "private-balance-policy-update-confirmed": [
    "wallet_preview_private_balance_policy_update",
    "wallet_apply_private_balance_policy_update",
  ],
  "private-balance-policy-update-cancelled": [
    "wallet_preview_private_balance_policy_update",
    "wallet_apply_private_balance_policy_update",
  ],
  "private-balance-public-change-regular-transfer": [
    "wallet_preview_regular_transfer",
    "wallet_execute_regular_transfer",
  ],
  "confirmed-exact-recovery": [
    "wallet_preview_recovery_transfer",
    "wallet_execute_recovery_transfer",
  ],
  "chat-recovery-cancelled": [
    "wallet_preview_recovery_transfer",
    "wallet_execute_recovery_transfer",
  ],
  "covered-public-read": ["egress_status", "egress_fetch"],
  "covered-read-needs-enrollment": ["egress_status"],
};

const alternativeTraceOrders = {
  // Both reads are non-mutating, and either may discover readiness first.
  "setup-ready": [
    ["capabilities", "onboarding_status", "wallet_get_tree"],
    // A blank disposable profile has no setup ID to resume. Starting the
    // idempotent setup flow is the contract-correct way to recover its status.
    ["capabilities", "onboarding_start", "wallet_get_tree"],
  ],
};

const expectedTurnTraces = {
  "ambiguous-old-wallet": [
    ["wallet_preview_saved_profile_load"],
    ["wallet_preview_saved_profile_load"],
  ],
  "start-new-demo-wallet": [
    ["wallet_start_new_demo"],
    ["wallet_start_new_demo"],
  ],
  "cancel-new-demo-wallet": [
    ["wallet_start_new_demo"],
    ["wallet_start_new_demo"],
  ],
  "confirmed-payment-with-emoji": [
    ["wallet_preview_private_transfer"],
    ["wallet_execute_private_transfer"],
  ],
  "indeterminate-payment-stays-unresolved": [
    ["wallet_preview_private_transfer"],
    ["wallet_execute_private_transfer"],
  ],
  "chat-payment-cancelled": [
    ["wallet_preview_private_transfer"],
    ["wallet_execute_private_transfer"],
  ],
  "confirmed-regular-transfer": [
    ["wallet_preview_regular_transfer"],
    ["wallet_execute_regular_transfer"],
  ],
  "chat-regular-transfer-cancelled": [
    ["wallet_preview_regular_transfer"],
    ["wallet_execute_regular_transfer"],
  ],
  "policy-update-with-confirmation": [
    ["wallet_plan_policy_update"],
    ["wallet_apply_policy_update"],
  ],
  "policy-update-cancelled": [
    ["wallet_plan_policy_update"],
    ["wallet_apply_policy_update"],
  ],
  "load-and-reauthorize-previous-wallet": [
    ["wallet_preview_saved_profile_load"],
    ["wallet_apply_saved_profile_load"],
    ["wallet_apply_reauthorization"],
  ],
  "named-source-regular-transfer": [
    ["wallet_preview_regular_transfer"],
    ["wallet_apply_saved_profile_load"],
    ["wallet_apply_reauthorization", "wallet_preview_regular_transfer"],
    ["wallet_execute_regular_transfer"],
  ],
  "current-chat-named-source-regular-transfer": [
    ["wallet_preview_regular_transfer"],
    ["wallet_apply_saved_profile_load"],
    ["wallet_apply_reauthorization", "wallet_preview_regular_transfer"],
    ["wallet_execute_regular_transfer"],
  ],
  "cancel-wallet-switch": [
    ["wallet_preview_saved_profile_load"],
    ["wallet_apply_saved_profile_load"],
  ],
  "adopt-local-wallet": [
    ["wallet_list_saved_profiles", "wallet_adopt_existing"],
    ["wallet_adopt_existing"],
  ],
  "cancel-wallet-adoption": [
    ["wallet_list_saved_profiles", "wallet_adopt_existing"],
    ["wallet_adopt_existing"],
  ],
  "create-named-wallet": [
    ["wallet_create"],
    ["wallet_create"],
  ],
  "cancel-wallet-creation": [
    ["wallet_create"],
    ["wallet_create"],
  ],
  "archive-inactive-wallet": [
    ["wallet_list_saved_profiles", "wallet_archive"],
    ["wallet_archive"],
  ],
  "cancel-wallet-archive": [
    ["wallet_list_saved_profiles", "wallet_archive"],
    ["wallet_archive"],
  ],
  "confirmed-exact-recovery": [
    ["wallet_preview_recovery_transfer"],
    ["wallet_execute_recovery_transfer"],
  ],
  "chat-recovery-cancelled": [
    ["wallet_preview_recovery_transfer"],
    ["wallet_execute_recovery_transfer"],
  ],
  "private-balance-create-confirmed": [
    ["wallet_preview_private_balance_create"],
    ["wallet_apply_private_balance_create"],
    ["wallet_get_tree"],
  ],
  "private-balance-fund-from-main": [
    ["wallet_preview_private_balance_fund"],
    ["wallet_apply_private_balance_fund"],
  ],
  "private-balance-fund-from-sibling": [
    ["wallet_preview_private_balance_fund"],
    ["wallet_apply_private_balance_fund"],
  ],
  "private-balance-policy-read": [
    ["wallet_get_private_balance_policy"],
  ],
  "private-balance-policy-update-confirmed": [
    ["wallet_preview_private_balance_policy_update"],
    ["wallet_apply_private_balance_policy_update"],
  ],
  "private-balance-policy-update-cancelled": [
    ["wallet_preview_private_balance_policy_update"],
    ["wallet_apply_private_balance_policy_update"],
  ],
  "private-balance-public-change-regular-transfer": [
    ["wallet_preview_regular_transfer"],
    ["wallet_execute_regular_transfer"],
  ],
};

const allowedTurnTraceAlternatives = {
  // A weak model may inspect the current policy exactly once before creating
  // the preview. This is read-only and remains constrained to this position;
  // repeated, reordered, or later policy reads still fail the trace grade.
  "policy-update-with-confirmation": {
    1: [["wallet_get_policy", "wallet_plan_policy_update"]],
  },
  "policy-update-cancelled": {
    1: [["wallet_get_policy", "wallet_plan_policy_update"]],
  },
};

const namedSourceTransferIntents = {
  "named-source-regular-transfer": {
    source: "saved-wallet",
    recipient: "agent-boost",
    amount: "0.1",
    expectedActive: "agent-boost",
    expectedActiveSelectionEpoch: 1,
  },
  "current-chat-named-source-regular-transfer": {
    source: "agent-boost",
    recipient: "new_private_wallet",
    amount: "0.1",
    expectedActive: "new_private_wallet",
    expectedActiveSelectionEpoch: 1,
  },
};

const savedProfileLoadBindings = {
  "load-and-reauthorize-previous-wallet": {
    target: "saved-wallet",
    previewReference: "my old wallet",
    expectedActive: "agent-boost",
    expectedActiveSelectionEpoch: 1,
    resolutionConfirmed: true,
    typedPreview: true,
  },
  "cancel-wallet-switch": {
    target: "saved-wallet",
    expectedActive: "agent-boost",
    expectedActiveSelectionEpoch: 1,
    resolutionConfirmed: false,
    typedPreview: true,
  },
  ...Object.fromEntries(
    Object.entries(namedSourceTransferIntents).map(([id, intent]) => [id, {
      target: intent.source,
      expectedActive: intent.expectedActive,
      expectedActiveSelectionEpoch: intent.expectedActiveSelectionEpoch,
      resolutionConfirmed: true,
      typedPreview: false,
    }]),
  ),
};

const expectedToolBindings = Object.fromEntries(fixtures.flows.map((flow) => {
  let turn = 0;
  const calls = [];
  for (const step of flow.steps) {
    if (step.actor === "user") turn += 1;
    if (step.actor === "tool") {
      calls.push({ turn, name: step.name, arguments: step.arguments ?? {} });
    }
  }
  return [flow.id, calls];
}));

const responseRules = {
  "setup-funding-qr": [
    { includes: ["1/3", "0.2", "Sepolia", "0x1111111111111111111111111111111111111111"], maxLines: 7 },
  ],
  "setup-partial-funding": [
    { includes: ["1/3", "0.15", "Next", "check again"], maxLines: 4 },
  ],
  "setup-preparing-private-balance": [
    { includes: ["2/3", "Funding found", "check again"], maxLines: 5 },
  ],
  "setup-ready": [
    {
      includes: ["3/3", "Dark Mode", "wallets/", "Tor", "Sepolia test payment"],
      exactBlock: canonicalWalletTree,
      excludes: ["0x", "Public balance", "Private balance"],
      maxLines: 11,
    },
  ],
  "setup-failed": [
    { includes: ["needs attention", "deadline", "Next"], maxLines: 4 },
  ],
  "start-new-demo-wallet": [
    { includes: ["archive", "fresh wallet", "Sepolia funding"], maxLines: 4 },
    { includes: ["1/3", "0.2", "Next"], maxLines: 5 },
  ],
  "cancel-new-demo-wallet": [
    { includes: ["archive", "fresh wallet", "Sepolia funding"], maxLines: 4 },
    { includes: ["cancelled", "unchanged"], maxLines: 3 },
  ],
  "advanced-setup-shows-live-policy": [
    { includes: ["Current wallet permission", "1 send", "0.05", "expiry"], maxLines: 4 },
  ],
  "wallet-tree-without-identifiers": [
    { includes: ["wallets/", "agent-boost/", "main/", "private/", "do not imply custody or control"], exact: canonicalWalletTree, maxLines: 6 },
  ],
  "plain-wallet-overview-uses-tree": [
    {
      includes: ["wallets/", "agent-boost/", "main/", "private/", "do not imply custody or control"],
      exact: canonicalWalletTree,
      maxLines: 6,
    },
  ],
  "saved-wallet-inventory": [
    { includes: ["agent-boost", "active", "saved-wallet", "imported-wallet", "adopt"], maxLines: 6 },
  ],
  "already-active-wallet-needs-no-switch": [
    { includes: ["agent-boost", "already", "active"], excludes: ["confirm", "authorize"], maxLines: 3 },
  ],
  "ambiguous-old-wallet": [
    { includes: ["saved-wallet", "travel-wallet", "which"], excludes: ["wallet_"], maxLines: 3 },
    { includes: ["saved-wallet", "switch", "signing", "cancel"], excludes: ["wallet_"], maxLines: 5 },
  ],
  "load-and-reauthorize-previous-wallet": [
    { includes: ["saved-wallet", "switch", "signing", "cancel"], maxLines: 5 },
    { includes: ["saved-wallet", "authorize", "0.05", "No funds"], maxLines: 8 },
    { includes: ["saved-wallet", "authorized", "No funds"], maxLines: 4 },
  ],
  "named-source-regular-transfer": [
    {
      includes: ["source-wallet switch", "saved-wallet", "agent-boost", "regular", "0.1", "switch"],
      excludes: ["0x", "authorize", "sent successfully"],
      maxLines: 6,
    },
    {
      includes: ["authorize", "saved-wallet", "0.1", "No funds"],
      excludes: ["0x", "transfer sent"],
      maxLines: 8,
    },
    {
      includes: ["regular", "0.1", "saved-wallet", "agent-boost", "approve"],
      excludes: ["0x", "transfer sent"],
      maxLines: 9,
    },
    {
      includes: ["Regular transfer sent", "0.1", "saved-wallet", "agent-boost", "confirmed"],
      excludes: ["0x"],
      maxLines: 6,
    },
  ],
  "current-chat-named-source-regular-transfer": [
    {
      includes: ["source-wallet switch", "agent-boost", "new_private_wallet", "regular", "0.1", "switch"],
      excludes: ["0x", "authorize", "sent successfully"],
      maxLines: 6,
    },
    {
      includes: ["authorize", "agent-boost", "0.1", "No funds"],
      excludes: ["0x", "transfer sent"],
      maxLines: 8,
    },
    {
      includes: ["regular", "0.1", "agent-boost", "new_private_wallet", "approve"],
      excludes: ["0x", "transfer sent"],
      maxLines: 9,
    },
    {
      includes: ["Regular transfer sent", "0.1", "agent-boost", "new_private_wallet", "confirmed"],
      excludes: ["0x"],
      maxLines: 6,
    },
  ],
  "cancel-wallet-switch": [
    { includes: ["saved-wallet", "switch", "signing", "cancel"], maxLines: 5 },
    { includes: ["cancelled", "Nothing changed"], maxLines: 3 },
  ],
  "adopt-local-wallet": [
    { includes: ["adopt", "imported-wallet", "signing", "cancel"], maxLines: 5 },
    { includes: ["Wallet adopted", "imported-wallet", "signing remains disabled"], maxLines: 4 },
  ],
  "cancel-wallet-adoption": [
    { includes: ["adopt", "imported-wallet", "signing", "cancel"], maxLines: 5 },
    { includes: ["adoption cancelled", "Nothing changed"], maxLines: 3 },
  ],
  "create-named-wallet": [
    { includes: ["new wallet", "travel-wallet", "profiles remain saved", "cancel"], maxLines: 5 },
    { includes: ["Wallet created", "travel-wallet", "earlier wallets remain saved"], maxLines: 4 },
  ],
  "cancel-wallet-creation": [
    { includes: ["new wallet", "travel-wallet", "profiles remain saved", "cancel"], maxLines: 5 },
    { includes: ["creation cancelled", "Nothing changed"], maxLines: 3 },
  ],
  "archive-inactive-wallet": [
    { includes: ["archive", "saved-wallet", "encrypted data", "cancel"], maxLines: 5 },
    { includes: ["Wallet archived", "encrypted wallet", "retained"], maxLines: 3 },
  ],
  "cancel-wallet-archive": [
    { includes: ["archive", "saved-wallet", "encrypted data", "cancel"], maxLines: 5 },
    { includes: ["archive cancelled", "Nothing changed"], maxLines: 3 },
  ],
  "ambiguous-amount-clarification": [
    { includes: ["exact amount", "0x1234567890abcdef1234567890abcdef12345678"], maxLines: 2 },
  ],
  "confirmed-payment-with-emoji": [
    {
      includes: ["private", "0.01", "0x1234567890abcdef1234567890abcdef12345678", "approve"],
      maxLines: 9,
    },
    { includes: ["Sent", "0.01", "0x1234567890abcdef1234567890abcdef12345678"], maxLines: 16 },
  ],
  "confirmed-regular-transfer": [
    { includes: ["regular", "0.01", "0x1234567890abcdef1234567890abcdef12345678", "public", "approve"], maxLines: 9 },
    { includes: ["regular", "0.01", "0x1234567890abcdef1234567890abcdef12345678", "confirmed"], maxLines: 6 },
  ],
  "ambiguous-transfer-mode": [
    { includes: ["regular", "private"], excludes: ["approve", "sent"], maxLines: 3 },
  ],
  "regular-transfer-gas-reserve-blocked": [
    {
      includes: ["regular", "blocked", "gas"],
      includesAny: [["Nothing was sent", "No funds sent"]],
      excludes: ["private"],
      maxLines: 6,
    },
  ],
  "chat-regular-transfer-cancelled": [
    { includes: ["regular", "0.01", "0x1234567890abcdef1234567890abcdef12345678", "public", "cancel"], maxLines: 8 },
    {
      includes: ["cancelled"],
      includesAny: [["Nothing was sent", "No transfer was sent", "No funds were sent"]],
      maxLines: 3,
    },
  ],
  "indeterminate-payment-stays-unresolved": [
    {
      includes: ["private", "0.01", "0x1234567890abcdef1234567890abcdef12345678", "approve"],
      maxLines: 9,
    },
    { includes: ["Not confirmed", "won’t retry"], maxLines: 16 },
  ],
  "chat-payment-cancelled": [
    {
      includes: ["private", "0.01", "0x1234567890abcdef1234567890abcdef12345678", "cancel"],
      maxLines: 9,
    },
    {
      includes: ["cancelled"],
      includesAny: [["Nothing was sent", "No payment was sent", "No funds were sent"]],
      maxLines: 14,
    },
  ],
  "main-balance-read": [
    { includes: ["Main account balance", "0.1 Sepolia ETH"], maxLines: 3 },
  ],
  "amount-affordability-is-server-computed": [
    { includes: ["cannot", "100", "policy"], excludes: ["can send 100", "sufficient funds"], maxLines: 4 },
  ],
  "local-deny-override": [
    { includes: ["blocked", "security policy"], excludes: ["approve"], maxLines: 3 },
  ],
  "local-allow-override": [
    { includes: ["Sent", "0.01", "0x1234567890abcdef1234567890abcdef12345678"], excludes: ["approve"], maxLines: 4 },
  ],
  "policy-update-with-confirmation": [
    { includes: ["New wallet permission", "Status", "Enabled", "10", "1", "approve"], maxLines: 10 },
    {
      includes: ["Permission updated", "Status", "Enabled", "10", "1"],
      includesAny: [["No funds moved", "No funds were moved", "did not move funds"]],
      maxLines: 8,
    },
  ],
  "policy-update-cancelled": [
    { includes: ["New wallet permission", "Status", "Enabled", "10", "1", "approve"], maxLines: 10 },
    {
      includes: ["cancelled", "no funds"],
      includesAny: [["unchanged", "not changed"]],
      maxLines: 3,
    },
  ],
  "expired-delegation-blocked": [
    { includes: ["blocked", "expired", "wallet"], excludes: ["approve"], maxLines: 4 },
  ],
  "private-balance-create-confirmed": [
    {
      includes: ["Confirm private balance creation", "savings", "agent-boost", "No funds", "separate"],
      excludes: ["0x", "created", "funded"],
      maxLines: 5,
    },
    {
      includes: ["Private balance created", "savings", "saved", "usable", "0 Sepolia ETH"],
      excludes: ["0x", "decision", "request"],
      maxLines: 4,
    },
    {
      includes: ["agent-boost/ [active]", "savings/", "trips/", "public-change/", "regular-sendable", "travel-wallet/", "reserve/", "last known"],
      excludes: ["0x"],
      exact: privateBalanceWalletTree,
      maxLines: 11,
    },
  ],
  "private-balance-fund-from-main": [
    {
      includes: ["private-balance funding", "agent-boost main public", "savings", "0.1", "network gas", "approve"],
      excludes: ["0x", "funded"],
      maxLines: 6,
    },
    {
      includes: ["Private balance funded", "savings", "0.1", "saved for future use"],
      excludes: ["0x"],
      maxLines: 4,
    },
  ],
  "private-balance-fund-from-sibling": [
    {
      includes: ["savings", "0.2", "denomination consumed", "trips", "0.1", "remainder", "paymaster fee", "correlatable", "approve"],
      excludes: ["0x", "funded"],
      maxLines: 7,
    },
    {
      includes: ["Private balance funded", "trips", "0.1", "saved for future use"],
      excludes: ["0x"],
      maxLines: 4,
    },
  ],
  "private-balance-policy-read": [
    {
      includes: ["trips permission", "Status", "Enabled", "1", "0.05", "remaining", "expiry"],
      excludes: ["0x", "approve"],
      maxLines: 3,
    },
  ],
  "private-balance-policy-update-confirmed": [
    {
      includes: ["Confirm trips permission", "Enabled", "4", "0.02", "0.08", "only that private balance", "No funds", "approve"],
      excludes: ["0x", "updated"],
      maxLines: 5,
    },
    {
      includes: ["Private balance permission updated", "Enabled", "4", "0.02", "0.08", "No funds"],
      excludes: ["0x", "parent policy"],
      maxLines: 4,
    },
  ],
  "private-balance-policy-update-cancelled": [
    {
      includes: ["Confirm trips permission", "4", "0.02", "0.08", "only that private balance", "approve"],
      excludes: ["0x", "updated"],
      maxLines: 5,
    },
    {
      includes: ["permission change cancelled", "unchanged", "no funds"],
      excludes: ["0x", "updated"],
      maxLines: 3,
    },
  ],
  "private-balance-public-change-regular-transfer": [
    {
      includes: ["regular", "public", "0.01", "savings public change", "0x1234567890abcdef1234567890abcdef12345678", "approve"],
      excludes: ["private payment", "main public account", "sent"],
      maxLines: 8,
    },
    {
      includes: ["Regular transfer sent", "0.01", "savings public change", "0x1234567890abcdef1234567890abcdef12345678", "confirmed"],
      excludes: ["private payment", "main public account"],
      maxLines: 5,
    },
  ],
  "confirmed-exact-recovery": [
    {
      includes: [
        "recovery",
        "private denomination",
        "0.1",
        "recipient",
        "0.01",
        "public remainder",
        "0.09",
        "fee reserve",
        "private balance after",
        "0.15",
        "0x1234567890abcdef1234567890abcdef12345678",
        "approve",
      ],
      maxLines: 10,
    },
    {
      includes: [
        "recovery",
        "confirmed",
        "private denomination",
        "0.1",
        "recipient",
        "0.01",
        "public remainder",
        "0.09",
        "fee reserve",
        "private balance after",
        "0.15",
      ],
      maxLines: 8,
    },
  ],
  "chat-recovery-cancelled": [
    {
      includes: [
        "recovery",
        "private denomination",
        "0.1",
        "recipient",
        "0.01",
        "public remainder",
        "0.09",
        "fee reserve",
        "private balance after",
        "0.15",
        "0x1234567890abcdef1234567890abcdef12345678",
        "cancel",
      ],
      maxLines: 10,
    },
    {
      includes: ["recovery", "cancelled"],
      includesAny: [["Nothing was signed", "Nothing was submitted", "Nothing was sent"]],
      maxLines: 4,
    },
  ],
  "covered-public-read": [
    { includes: ["status", "ok", "no direct fallback"], maxLines: 4 },
  ],
  "covered-read-needs-enrollment": [
    { includes: ["needs", "operator enrollment", "direct request"], maxLines: 3 },
  ],
};

const forbidden = [
  /\bmcp\b/iu,
  /\bwei\b/iu,
  /\b(?:decision_id|request_id|client_request_id|user_confirmed|wallet_id|wallet_name|amount_atomic|amount_native)\b/iu,
  /\b(?:wallet_get_context|wallet_get_main_balance|wallet_get_tree|wallet_list_saved_profiles|wallet_preview_saved_profile_load|wallet_apply_saved_profile_load|wallet_get_saved_profiles|wallet_manage_profiles|wallet_list|wallet_get_policy|wallet_plan_policy_update|wallet_apply_policy_update|wallet_preview_private_balance_create|wallet_apply_private_balance_create|wallet_preview_private_balance_fund|wallet_apply_private_balance_fund|wallet_get_private_balance_operation|wallet_get_private_balance_policy|wallet_preview_private_balance_policy_update|wallet_apply_private_balance_policy_update|wallet_start_new_demo|wallet_create|wallet_adopt_existing|wallet_select|wallet_switch_saved_profile|wallet_archive|wallet_plan_reauthorization|wallet_reauthorize|wallet_apply_reauthorization|wallet_preview_regular_transfer|wallet_plan_regular_transfer|wallet_execute_regular_transfer|wallet_get_regular_transfer_request|wallet_preview_private_transfer|wallet_plan_private_payment|wallet_execute_private_transfer|wallet_execute_private_payment|wallet_get_request|wallet_get_private_transfer_request|wallet_get_private_payment_request|wallet_preview_recovery_transfer|wallet_plan_recovery_transfer|wallet_execute_recovery_transfer|wallet_get_recovery_request|egress_status|egress_fetch)\b/iu,
  /\borg\.agentboost\/model-context\b/iu,
  /\b(?:native|external|another|system)\b[^\n]{0,40}\b(?:approval|confirmation|interface|prompt|surface|ui)\b|\b(?:button|popup|notification)\b/iu,
  /\b(?:plan|decision|request|wallet)\s+id\b/iu,
  /\b(?:seed phrase|private key|wallet password)\b/iu,
  /\b(?:(?:wd|wpd|pbc|pbcr|pbf|pbfr|pbp|pbpr|req|rwd|rreq|wra|wr|wrr|wallet|auth|setup|archive)_|sha256:)[A-Za-z0-9._:-]*/u,
  /OUT-OF-BAND USER MESSAGE|<\/?user message>/iu,
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const hermes = resolveExecutable(options.hermes);
  const definitionFailures = validateLiveEvalDefinitions();
  if (definitionFailures.length > 0) {
    throw new Error(`Invalid live eval definitions: ${definitionFailures.join("; ")}`);
  }
  const requested = options.cases.length
    ? new Set(options.cases)
    : new Set(Object.keys(expectedTraces));
  const flows = fixtures.flows.filter((flow) => requested.has(flow.id));
  if (flows.length !== requested.size) {
    const found = new Set(flows.map((flow) => flow.id));
    throw new Error(`Unknown eval case: ${[...requested].find((id) => !found.has(id))}`);
  }

  const reports = [];
  for (const flow of flows) reports.push(await runFlow(flow, hermes, options));
  const report = {
    schema: "org.agentboost.live-hermes-eval",
    schema_version: "1.0",
    passed: reports.every((entry) => entry.passed),
    hermes,
    provider: options.provider ?? (options.baseUrl ? "custom" : "profile default"),
    model: options.model ?? "profile default",
    cases: reports,
  };
  if (options.report) {
    await mkdir(dirname(resolve(options.report)), { recursive: true, mode: 0o700 });
    await writeFile(resolve(options.report), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

async function runFlow(flow, hermes, options) {
  const sandbox = await mkdtemp(join(tmpdir(), `agent-boost-hermes-eval-${flow.id}-`));
  await chmod(sandbox, 0o700);
  const home = join(sandbox, "hermes");
  const tracePath = join(sandbox, "tool-trace.ndjson");
  for (const skillName of hermesSkillNames) {
    await mkdir(join(home, "skills", skillName), { recursive: true, mode: 0o700 });
    await copyFile(
      join(root, "integrations", "hermes", skillName, "SKILL.md"),
      join(home, "skills", skillName, "SKILL.md"),
    );
  }
  const outputGuardDirectory = join(home, "plugins", "agent-boost-output-guard");
  await mkdir(outputGuardDirectory, { recursive: true, mode: 0o700 });
  for (const file of ["__init__.py", "plugin.yaml"]) {
    await copyFile(
      join(root, "integrations", "hermes", "agent-boost-output-guard", file),
      join(outputGuardDirectory, file),
    );
  }
  await writeFile(tracePath, "", { mode: 0o600 });
  const tsx = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  const turnGateExecutable = join(sandbox, "agent-boost-live-eval");
  await writeFile(
    turnGateExecutable,
    `#!/bin/sh\nexec ${shellCommandWord(tsx)} ${shellCommandWord(join(root, "src", "cli.ts"))} "$@"\n`,
    { mode: 0o700 },
  );
  await chmod(turnGateExecutable, 0o700);
  const resolvedTurnGateExecutable = await realpath(turnGateExecutable);
  const turnGateCommand = `${shellCommandWord(resolvedTurnGateExecutable)} hermes-turn-gate`;
  const turnGate = liveEvalTurnGateConfig(turnGateCommand);
  await writeFile(
    join(home, "shell-hooks-allowlist.json"),
    `${JSON.stringify(liveEvalHookAllowlist(turnGateCommand), null, 2)}\n`,
    { mode: 0o600 },
  );
  const config = {
    onboarding: { seen: { busy_input_prompt: true } },
    memory: { enabled: false, write_approval: true },
    skills: { write_approval: true },
    agent: liveEvalAgentConfig(),
    tools: liveEvalToolsConfig(),
    hooks_auto_accept: false,
    hooks: turnGate.hooks,
    display: { busy_input_mode: "queue" },
    plugins: liveEvalPluginConfig(resolvedTurnGateExecutable),
    ...(options.baseUrl
      ? {
          model: {
            provider: options.provider ?? "custom",
            default: options.model,
            base_url: options.baseUrl,
            api_key: "local-eval-not-a-secret",
          },
        }
      : {}),
    mcp_servers: {
      "agent-boost": {
        command: tsx,
        args: [join(root, "evals", "fake-mcp.ts")],
        env: {
          AGENT_BOOST_EVAL_SCENARIO: flow.scenario,
          AGENT_BOOST_EVAL_CASE: flow.id,
          AGENT_BOOST_EVAL_TRACE: tracePath,
          AGENT_BOOST_EVAL_TURN: "${AGENT_BOOST_EVAL_TURN}",
        },
        enabled: true,
        timeout: 30,
        supports_parallel_tool_calls: false,
        tools: {
          include: [
            "capabilities",
            "onboarding_start",
            "onboarding_status",
            "wallet_get_main_balance",
            "wallet_get_tree",
            "wallet_list_saved_profiles",
            "wallet_preview_private_balance_create",
            "wallet_apply_private_balance_create",
            "wallet_preview_private_balance_fund",
            "wallet_apply_private_balance_fund",
            "wallet_get_private_balance_operation",
            "wallet_get_private_balance_policy",
            "wallet_preview_private_balance_policy_update",
            "wallet_apply_private_balance_policy_update",
            "wallet_get_policy",
            "wallet_plan_policy_update",
            "wallet_apply_policy_update",
            "wallet_start_new_demo",
            "wallet_create",
            "wallet_adopt_existing",
            "wallet_preview_saved_profile_load",
            "wallet_apply_saved_profile_load",
            "wallet_archive",
            "wallet_plan_reauthorization",
            "wallet_apply_reauthorization",
            "wallet_preview_regular_transfer",
            "wallet_execute_regular_transfer",
            "wallet_get_regular_transfer_request",
            "wallet_preview_private_transfer",
            "wallet_execute_private_transfer",
            "wallet_get_private_transfer_request",
            "wallet_preview_recovery_transfer",
            "wallet_execute_recovery_transfer",
            "wallet_get_recovery_request",
            "egress_capabilities",
            "egress_status",
            "egress_fetch",
          ],
          resources: false,
          prompts: false,
        },
      },
    },
    platform_toolsets: { cli: ["agent-boost"] },
  };
  await writeFile(join(home, "config.yaml"), stringifyYaml(config), { mode: 0o600 });
  if (options.baseUrl) {
    await writeFile(
      join(home, ".env"),
      `OPENAI_BASE_URL=${options.baseUrl}\nOPENAI_API_KEY=local-eval-not-a-secret\n`,
      { mode: 0o600 },
    );
  }

  const environment = { ...process.env };
  environment.HERMES_HOME = home;
  environment.AGENT_BOOST_EVAL_SCENARIO = flow.scenario;
  environment.AGENT_BOOST_EVAL_CASE = flow.id;
  environment.AGENT_BOOST_EVAL_TRACE = tracePath;
  environment.HERMES_SKIP_UPDATE_CHECK = "1";
  delete environment.HERMES_SESSION_ID;

  const outputs = [];
  let sessionId;
  try {
    const userSteps = flow.steps.filter((entry) => entry.actor === "user");
    for (const [turnIndex, step] of userSteps.entries()) {
      const turn = turnIndex + 1;
      environment.AGENT_BOOST_EVAL_TURN = String(turn);
      const skillName = skillForFlowTurn(flow.id, turn);
      const skillArgs = flow.skill_loading === "progressive"
        ? []
        : ["--skills", skillName];
      const toolsets = toolsetsForFlow(flow);
      const args = [
        "chat",
        "-q",
        step.text,
        "-Q",
        "--source",
        "tool",
        "--toolsets",
        toolsets,
        ...skillArgs,
        "--max-turns",
        "12",
        ...(sessionId ? ["--resume", sessionId] : []),
        ...(!options.baseUrl && options.model ? ["--model", options.model] : []),
        ...(!options.baseUrl && options.provider ? ["--provider", options.provider] : []),
      ];
      const result = await spawnCapture(hermes, args, {
        cwd: sandbox,
        env: environment,
        timeoutMs: options.timeoutMs,
        stdin: "",
      });
      if (result.exitCode !== 0) {
        const diagnostic = [result.stderr.trim(), result.stdout.trim()]
          .filter(Boolean)
          .join("\n");
        throw new Error(`Hermes exited ${result.exitCode}: ${publicDiagnostic(diagnostic)}`);
      }
      sessionId = parseSessionId(result.stderr) ?? sessionId;
      if (!sessionId) throw new Error("Hermes quiet output did not include a session ID");
      outputs.push(cleanHermesResponse(result.stdout));
    }
    const traces = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const failures = grade(flow.id, outputs, traces);
    return {
      id: flow.id,
      passed: failures.length === 0,
      failures,
      responses: outputs,
      tool_trace: traces.map((entry) => entry.name),
      tool_trace_by_turn: traces.map((entry) => ({
        turn: entry.turn,
        name: entry.name,
      })),
    };
  } catch (error) {
    return {
      id: flow.id,
      passed: false,
      failures: [error instanceof Error ? error.message : String(error)],
      responses: outputs,
      tool_trace: [],
      tool_trace_by_turn: [],
    };
  } finally {
    if (options.keep) {
      process.stderr.write(`Preserved ${flow.id} sandbox: ${sandbox}\n`);
    } else {
      await rm(sandbox, { recursive: true, force: true });
    }
  }
}

function grade(id, outputs, traces) {
  const failures = [];
  const rules = responseRules[id];
  if (outputs.length !== rules.length) {
    failures.push(`expected ${rules.length} assistant turns, received ${outputs.length}`);
  }
  for (let index = 0; index < Math.min(outputs.length, rules.length); index += 1) {
    const output = outputs[index];
    const rule = rules[index];
    if (rule.exact !== undefined && output !== rule.exact) {
      failures.push(`turn ${index + 1} does not exactly match the canonical response`);
    }
    if (rule.exactBlock !== undefined && !output.includes(rule.exactBlock)) {
      failures.push(`turn ${index + 1} is missing the exact canonical response block`);
    }
    const visibleLines = output.split("\n").filter((line) => line.trim().length > 0).length;
    if (visibleLines > rule.maxLines) {
      failures.push(`turn ${index + 1} exceeds ${rule.maxLines} lines`);
    }
    for (const required of rule.includes) {
      if (!output.toLocaleLowerCase().includes(required.toLocaleLowerCase())) {
        failures.push(`turn ${index + 1} is missing ${JSON.stringify(required)}`);
      }
    }
    for (const alternatives of rule.includesAny ?? []) {
      if (!alternatives.some((value) =>
        output.toLocaleLowerCase().includes(value.toLocaleLowerCase())
      )) {
        failures.push(
          `turn ${index + 1} is missing one of ${alternatives.map(JSON.stringify).join(", ")}`,
        );
      }
    }
    for (const excluded of rule.excludes ?? []) {
      if (output.toLocaleLowerCase().includes(excluded.toLocaleLowerCase())) {
        failures.push(`turn ${index + 1} unexpectedly includes ${JSON.stringify(excluded)}`);
      }
    }
    for (const pattern of forbidden) {
      if (pattern.test(output)) failures.push(`turn ${index + 1} exposes ${pattern}`);
    }
  }
  failures.push(...gradeToolTrace(id, traces));
  return failures;
}

export function gradeToolTrace(id, traces) {
  const failures = [];
  const invalidTurns = traces.filter(
    (entry) => !Number.isSafeInteger(entry.turn) || entry.turn < 1,
  );
  if (invalidTurns.length > 0) {
    failures.push(
      `tool trace contains ${invalidTurns.length} entr${invalidTurns.length === 1 ? "y" : "ies"} without a positive integer turn`,
    );
  }

  const requiredTraces = traces;
  failures.push(...gradeToolArguments(id, requiredTraces));
  const expectedByTurn = expectedTurnTraces[id];
  if (expectedByTurn) {
    for (let turn = 1; turn <= expectedByTurn.length; turn += 1) {
      const expected = expectedByTurn[turn - 1];
      const received = requiredTraces
        .filter((entry) => entry.turn === turn)
        .map((entry) => entry.name);
      const alternatives = allowedTurnTraceAlternatives[id]?.[turn] ?? [];
      const accepted = [expected, ...alternatives];
      if (!accepted.some((candidate) => JSON.stringify(received) === JSON.stringify(candidate))) {
        const expectedLabel = accepted
          .map((candidate) => candidate.join(", ") || "none")
          .join(" OR ");
        failures.push(
          `tool trace mismatch on turn ${turn}: expected ${expectedLabel}; received ${received.join(", ") || "none"}`,
        );
      }
    }
    const outsideExpectedTurns = requiredTraces.filter(
      (entry) => Number.isSafeInteger(entry.turn) && entry.turn > expectedByTurn.length,
    );
    if (outsideExpectedTurns.length > 0) {
      failures.push(
        `tool trace has calls after turn ${expectedByTurn.length}: ${outsideExpectedTurns.map((entry) => `turn ${entry.turn} ${entry.name}`).join(", ")}`,
      );
    }
    const namedIntent = namedSourceTransferIntents[id];
    if (namedIntent) {
      const plannerCalls = requiredTraces.filter(
        (entry) => entry.name === "wallet_preview_regular_transfer",
      );
      if (plannerCalls.length !== 2) {
        failures.push(
          `${id} expected 2 planner calls; received ${plannerCalls.length}`,
        );
      }
      for (const entry of plannerCalls) {
        const argumentsValue = entry.arguments ?? {};
        const source = argumentsValue.source;
        const recipient = argumentsValue.destination;
        const sourceMatches = entry.turn === 1
          ? normalizeWalletReference(source) === normalizeWalletReference(namedIntent.source)
          : source === namedIntent.source;
        const recipientMatches = entry.turn === 1
          ? normalizeWalletReference(recipient) === normalizeWalletReference(namedIntent.recipient)
          : recipient === namedIntent.recipient;
        if (
          !sourceMatches ||
          !recipientMatches ||
          argumentsValue.amount_native !== namedIntent.amount ||
          Object.keys(argumentsValue).some(
            (key) => !["source", "destination", "amount_native"].includes(key),
          )
        ) {
          failures.push(
            `${id} planner arguments changed on turn ${entry.turn}`,
          );
        }
      }
    }
    const loadBinding = savedProfileLoadBindings[id];
    if (loadBinding) {
      const previewCalls = requiredTraces.filter(
        (entry) => entry.name === "wallet_preview_saved_profile_load",
      );
      const applyCalls = requiredTraces.filter(
        (entry) => entry.name === "wallet_apply_saved_profile_load",
      );
      const expectedPreviewCount = loadBinding.typedPreview ? 1 : 0;
      if (previewCalls.length !== expectedPreviewCount || applyCalls.length !== 1) {
        failures.push(
          `${id} expected ${expectedPreviewCount} saved-profile load preview${expectedPreviewCount === 1 ? "" : "s"} and 1 apply; received ${previewCalls.length} and ${applyCalls.length}`,
        );
      } else {
        if (loadBinding.typedPreview) {
          const previewArguments = previewCalls[0].arguments ?? {};
          if (
            previewCalls[0].turn !== 1 ||
            previewArguments.wallet_name !==
              (loadBinding.previewReference ?? loadBinding.target) ||
            Object.keys(previewArguments).some((key) => key !== "wallet_name")
          ) {
            failures.push(`${id} saved-profile load preview changed on turn ${previewCalls[0].turn}`);
          }
        }
        const resolutionCall = applyCalls[0];
        const argumentsValue = resolutionCall.arguments ?? {};
        if (
          argumentsValue.wallet_name !== loadBinding.target ||
          argumentsValue.expected_active_wallet_name !== loadBinding.expectedActive ||
          argumentsValue.expected_active_selection_epoch !==
            loadBinding.expectedActiveSelectionEpoch ||
          argumentsValue.user_confirmed !== loadBinding.resolutionConfirmed ||
          Object.keys(argumentsValue).some((key) => ![
            "wallet_name",
            "expected_active_wallet_name",
            "expected_active_selection_epoch",
            "user_confirmed",
          ].includes(key))
        ) {
          failures.push(`${id} saved-profile load binding changed on turn ${resolutionCall.turn}`);
        }
      }
    }
    return failures;
  }

  const names = requiredTraces.map((entry) => entry.name);
  const acceptedTraces = [
    expectedTraces[id],
    ...(alternativeTraceOrders[id] ?? []),
  ];
  if (!acceptedTraces.some((trace) => JSON.stringify(names) === JSON.stringify(trace))) {
    failures.push(
      `tool trace mismatch: expected ${acceptedTraces.map((trace) => trace.join(", ") || "none").join(" or ")}; received ${names.join(", ") || "none"}`,
    );
  }
  return failures;
}

function gradeToolArguments(id, traces) {
  const failures = [];
  const expectedByKey = new Map();
  for (const entry of expectedToolBindings[id] ?? []) {
    const key = `${entry.turn}:${entry.name}`;
    const values = expectedByKey.get(key) ?? [];
    values.push(entry.arguments);
    expectedByKey.set(key, values);
  }
  const receivedCounts = new Map();
  for (const entry of traces) {
    if (
      namedSourceTransferIntents[id] &&
      entry.name === "wallet_preview_regular_transfer"
    ) {
      // Friendly names on the first call are compared semantically below;
      // later calls must use the exact canonical references.
      continue;
    }
    const key = `${entry.turn}:${entry.name}`;
    const occurrence = receivedCounts.get(key) ?? 0;
    receivedCounts.set(key, occurrence + 1);
    const expected = expectedByKey.get(key)?.[occurrence];
    const received = entry.arguments ?? {};
    if (expected === undefined) {
      // The only accepted fixture alternative without a matching tool step is
      // the idempotent no-argument onboarding_start recovery path.
      if (!sameFlatArguments({}, received)) {
        failures.push(
          `${id} ${entry.name} has unexpected arguments on turn ${entry.turn}: ${JSON.stringify(received)}`,
        );
      }
      continue;
    }
    if (!sameFlatArguments(expected, received)) {
      failures.push(
        `${id} ${entry.name} arguments mismatch on turn ${entry.turn}; expected ${JSON.stringify(expected)}, received ${JSON.stringify(received)}`,
      );
    }
  }
  return failures;
}

function sameFlatArguments(expected, received) {
  if (
    !expected || typeof expected !== "object" || Array.isArray(expected) ||
    !received || typeof received !== "object" || Array.isArray(received)
  ) {
    return false;
  }
  const expectedKeys = Object.keys(expected).sort();
  const receivedKeys = Object.keys(received).sort();
  return JSON.stringify(expectedKeys) === JSON.stringify(receivedKeys) &&
    expectedKeys.every((key) =>
      Object.is(expected[key], received[key]) ||
      (
        key.endsWith("_native") &&
        typeof expected[key] === "string" &&
        typeof received[key] === "number" &&
        Number.isSafeInteger(received[key]) &&
        expected[key] === String(received[key])
      )
    );
}

export function validateLiveEvalDefinitions() {
  const failures = [];
  const flowById = new Map(fixtures.flows.map((flow) => [flow.id, flow]));
  for (const flow of fixtures.flows) {
    const userTurnCount = flow.steps.filter((step) => step.actor === "user").length;
    if (!Object.hasOwn(expectedTraces, flow.id)) {
      failures.push(`${flow.id} has no expected tool trace`);
    }
    if (!Object.hasOwn(responseRules, flow.id)) {
      failures.push(`${flow.id} has no response rules`);
    }
    const skillSequence = skillSequenceByFlow[flow.id];
    if (!skillSequence) {
      failures.push(`${flow.id} has no specialist skill sequence`);
      continue;
    }
    if (skillSequence.length !== userTurnCount) {
      failures.push(
        `${flow.id} has ${skillSequence.length} specialist skills for ${userTurnCount} user turns`,
      );
    }
    for (const skillName of skillSequence) {
      if (!hermesSkillNames.includes(skillName)) {
        failures.push(`${flow.id} references unknown specialist skill ${skillName}`);
      }
    }
  }
  for (const [id, expectedTrace] of Object.entries(expectedTraces)) {
    const flow = flowById.get(id);
    if (!flow) {
      failures.push(`${id} has no fixture flow`);
      continue;
    }
    const userTurnCount = flow.steps.filter((step) => step.actor === "user").length;
    const ruleCount = responseRules[id]?.length ?? 0;
    if (ruleCount !== userTurnCount) {
      failures.push(`${id} has ${ruleCount} response rules for ${userTurnCount} user turns`);
    }
    const byTurn = expectedTurnTraces[id];
    if (byTurn && byTurn.length !== userTurnCount) {
      failures.push(`${id} has ${byTurn.length} expected trace turns for ${userTurnCount} user turns`);
    }
    if (byTurn && JSON.stringify(byTurn.flat()) !== JSON.stringify(expectedTrace)) {
      failures.push(`${id} per-turn trace does not flatten to its aggregate trace`);
    }
  }
  return failures;
}

export function skillForFlowTurn(id, turn) {
  const sequence = skillSequenceByFlow[id];
  if (!sequence) throw new Error(`No specialist skill sequence for ${id}`);
  const skillName = sequence[turn - 1];
  if (!skillName) throw new Error(`No specialist skill for ${id} turn ${turn}`);
  return skillName;
}

export function toolsetsForFlow(flow) {
  return flow.skill_loading === "progressive"
    ? "agent-boost,skills"
    : "agent-boost";
}

export function liveEvalToolsConfig() {
  return { tool_search: { enabled: "off" } };
}

export function liveEvalAgentConfig() {
  return {
    // General tool-use enforcement prevents weak models from replacing a
    // required call with confident prose. The broader keep-working prompts
    // remain off because Agent Boost owns consequence-aware turn boundaries.
    tool_use_enforcement: true,
    execution_guidance: false,
    task_completion_guidance: false,
    parallel_tool_call_guidance: false,
    system_prompt: HERMES_AGENT_BOOST_SYSTEM_PROMPT_BLOCK,
  };
}

export function liveEvalTurnGateConfig(command) {
  return {
    hooks: {
      pre_tool_call: [{
        matcher: ".*",
        command,
        timeout: 5,
        fail_closed: true,
      }],
      post_tool_call: [{
        matcher: "(?:mcp__agent_boost__.*|tool_call)",
        command,
        timeout: 5,
      }],
    },
  };
}

export function liveEvalHookAllowlist(command) {
  return {
    approvals: [
      { event: "pre_tool_call", command },
      { event: "post_tool_call", command },
    ],
  };
}

export function liveEvalPluginConfig(executable) {
  return {
    enabled: ["agent-boost-output-guard"],
    entries: {
      "agent-boost-output-guard": {
        settings: { turn_gate_executable: executable },
      },
    },
  };
}

function shellCommandWord(value) {
  const word = String(value);
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(word)
    ? word
    : `'${word.replaceAll("'", `'"'"'`)}'`;
}

function normalizeWalletReference(value) {
  const tokens = String(value ?? "")
    .trim()
    .toLocaleLowerCase()
    .split(/[\s_-]+/u)
    .filter(Boolean);
  if (tokens[0] === "my" || tokens[0] === "the") tokens.shift();
  if (tokens.at(-1) === "wallet") tokens.pop();
  return tokens.join("");
}

function parseArgs(args) {
  const options = { cases: [], keep: false, timeoutMs: 180_000 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--keep") options.keep = true;
    else if (["--hermes", "--case", "--model", "--provider", "--base-url", "--report", "--timeout-ms"].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--case") options.cases.push(value);
      else if (arg === "--timeout-ms") options.timeoutMs = Number(value);
      else if (arg === "--base-url") options.baseUrl = value;
      else options[arg.slice(2)] = value;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: npm run eval:live -- --hermes /absolute/path/to/hermes [--case ID] [--provider PROVIDER] [--model MODEL] [--base-url URL] [--report PATH] [--keep]\n",
      );
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.hermes) throw new Error("--hermes is required");
  if (options.baseUrl) {
    if (!options.model) throw new Error("--base-url requires --model");
    const baseUrl = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(baseUrl.protocol)) {
      throw new Error("--base-url must use http or https");
    }
    if (!["127.0.0.1", "::1", "localhost"].includes(baseUrl.hostname)) {
      throw new Error("--base-url is limited to a loopback model endpoint");
    }
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  return options;
}

function resolveExecutable(value) {
  if (!isAbsolute(value)) throw new Error("--hermes must be an absolute path");
  return resolve(value);
}

function parseSessionId(stderr) {
  return stderr.match(/(?:^|\n)session_id:\s*([^\s]+)/u)?.[1];
}

function cleanHermesResponse(stdout) {
  return stdout
    .split("\n")
    .filter((line) =>
      !/^⚠ tirith security scanner enabled but not available\b/iu.test(line.trim())
    )
    .join("\n")
    .trim();
}

function publicDiagnostic(stderr) {
  return stderr
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[redacted-url]")
    .replace(/\/(?:Users|home|private|tmp|var|etc|opt|root)\/[^\s"'<>]*/giu, "[redacted-path]")
    .replace(/\b(?:gh[opsu]|sk|key|token)_[A-Za-z0-9_-]{8,}\b/giu, "[redacted-secret]")
    .slice(0, 1_000);
}

function spawnCapture(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(options.stdin ?? "");
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectPromise(new Error(`Hermes eval timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    process.stderr.write(`live Hermes eval: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
