// Ordered permission rules for agent specs and delegation.
//
// Evaluation is deliberately small and deterministic: first matching rule wins,
// and no match means deny. The narrowing checker is conservative; a child allow
// must fit inside a parent allow without crossing an earlier parent deny.

import { resolve } from "path";
import { homedir } from "os";

export const PERMISSION_CAPABILITIES = Object.freeze([
  "read",
  "write",
  "execute",
  "network",
  "database",
  "memory",
]);

export const PERMISSION_EFFECTS = Object.freeze(["allow", "deny"]);

const CAPABILITY_SET = new Set(PERMISSION_CAPABILITIES);
const EFFECT_SET = new Set(PERMISSION_EFFECTS);
const PATH_CAPABILITIES = new Set(["read", "write", "execute"]);
const RULE_KEYS = new Set(["capability", "effect", "action", "resource", "description"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function fail(path, message) {
  throw new TypeError(`Invalid agent permission policy ${path}: ${message}`);
}

function expandTilde(value) {
  return value.replace(/^~(?=\/|$)/, homedir());
}

function normalizePathResource(value) {
  if (value === "*" || value === undefined || value === null) return "*";
  return resolve(expandTilde(String(value)));
}

function normalizeResource(capability, value) {
  if (PATH_CAPABILITIES.has(capability)) return normalizePathResource(value);
  if (value === undefined || value === null || value === "*") return "*";
  const s = String(value).trim();
  if (!s) return "*";
  return capability === "network" ? s.toLowerCase() : s;
}

function normalizeAction(value) {
  if (value === undefined || value === null || value === "*") return "*";
  const s = String(value).trim();
  return s || "*";
}

function normalizeRule(input, index) {
  if (!isPlainObject(input)) fail(`.rules[${index}]`, "must be an object");
  for (const key of Object.keys(input)) {
    if (!RULE_KEYS.has(key)) fail(`.rules[${index}]`, `unknown field "${key}"`);
  }
  const capability = String(input.capability ?? "").trim();
  if (!CAPABILITY_SET.has(capability)) {
    fail(`.rules[${index}].capability`, `must be one of ${PERMISSION_CAPABILITIES.join(", ")}`);
  }
  const effect = String(input.effect ?? "").trim();
  if (!EFFECT_SET.has(effect)) {
    fail(`.rules[${index}].effect`, `must be one of ${PERMISSION_EFFECTS.join(", ")}`);
  }
  const description = input.description == null ? null : String(input.description).trim() || null;
  return Object.freeze({
    capability,
    effect,
    action: normalizeAction(input.action),
    resource: normalizeResource(capability, input.resource),
    description,
  });
}

export function normalizePermissionPolicy(input = {}) {
  const rawRules = Array.isArray(input) ? input : input?.rules;
  if (!Array.isArray(rawRules)) fail(".rules", "must be an array");
  return Object.freeze({
    rules: Object.freeze(rawRules.map((rule, index) => normalizeRule(rule, index))),
  });
}

function actionMatches(ruleAction, requestAction) {
  return ruleAction === "*" || ruleAction === requestAction;
}

function actionCovers(parentAction, childAction) {
  return parentAction === "*" || parentAction === childAction;
}

function pathIsUnder(child, parent) {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

function resourceMatches(capability, ruleResource, requestResource) {
  if (ruleResource === "*") return true;
  if (requestResource === "*") return false;
  if (PATH_CAPABILITIES.has(capability)) return pathIsUnder(requestResource, ruleResource);
  return ruleResource === requestResource;
}

function resourceCovers(capability, parentResource, childResource) {
  if (parentResource === "*") return true;
  if (childResource === "*") return false;
  if (PATH_CAPABILITIES.has(capability)) return pathIsUnder(childResource, parentResource);
  return parentResource === childResource;
}

function resourceIntersects(capability, a, b) {
  if (a === "*" || b === "*") return true;
  if (PATH_CAPABILITIES.has(capability)) return pathIsUnder(a, b) || pathIsUnder(b, a);
  return a === b;
}

function normalizeRequest(request) {
  if (!isPlainObject(request)) fail(".request", "must be an object");
  const capability = String(request.capability ?? "").trim();
  if (!CAPABILITY_SET.has(capability)) {
    fail(".request.capability", `must be one of ${PERMISSION_CAPABILITIES.join(", ")}`);
  }
  return Object.freeze({
    capability,
    action: normalizeAction(request.action),
    resource: normalizeResource(capability, request.resource),
  });
}

function ruleMatchesRequest(rule, request) {
  return rule.capability === request.capability &&
    actionMatches(rule.action, request.action) &&
    resourceMatches(rule.capability, rule.resource, request.resource);
}

export function evaluatePermission(policyInput, requestInput) {
  const policy = normalizePermissionPolicy(policyInput);
  const request = normalizeRequest(requestInput);
  for (let index = 0; index < policy.rules.length; index++) {
    const rule = policy.rules[index];
    if (!ruleMatchesRequest(rule, request)) continue;
    return Object.freeze({
      allowed: rule.effect === "allow",
      effect: rule.effect,
      rule,
      ruleIndex: index,
      reason: "matched",
    });
  }
  return Object.freeze({
    allowed: false,
    effect: "deny",
    rule: null,
    ruleIndex: -1,
    reason: "default-deny",
  });
}

function ruleCouldApplyToChildAllow(parentRule, childRule) {
  return parentRule.capability === childRule.capability &&
    actionCovers(parentRule.action, childRule.action) &&
    resourceIntersects(parentRule.capability, parentRule.resource, childRule.resource);
}

function parentCoversChildAllow(parentPolicy, childRule) {
  for (let index = 0; index < parentPolicy.rules.length; index++) {
    const parentRule = parentPolicy.rules[index];
    if (!ruleCouldApplyToChildAllow(parentRule, childRule)) continue;
    if (parentRule.effect === "deny") {
      return { ok: false, index, rule: parentRule, reason: "blocked-by-parent-deny" };
    }
    if (
      actionCovers(parentRule.action, childRule.action) &&
      resourceCovers(parentRule.capability, parentRule.resource, childRule.resource)
    ) {
      return { ok: true, index, rule: parentRule, reason: "covered-by-parent-allow" };
    }
    return { ok: false, index, rule: parentRule, reason: "parent-allow-too-narrow" };
  }
  return { ok: false, index: -1, rule: null, reason: "no-parent-allow" };
}

export class AgentPermissionNarrowingError extends Error {
  constructor(childRule, detail) {
    const target = `${childRule.capability}:${childRule.action}:${childRule.resource}`;
    super(`Child agent permission widens parent policy at ${target} (${detail.reason})`);
    this.name = "AgentPermissionNarrowingError";
    this.childRule = childRule;
    this.parentRule = detail.rule;
    this.parentRuleIndex = detail.index;
    this.reason = detail.reason;
  }
}

export function assertPermissionNarrowing(parentInput, childInput) {
  const parent = normalizePermissionPolicy(parentInput);
  const child = normalizePermissionPolicy(childInput);
  for (const childRule of child.rules) {
    if (childRule.effect !== "allow") continue;
    const detail = parentCoversChildAllow(parent, childRule);
    if (!detail.ok) throw new AgentPermissionNarrowingError(childRule, detail);
  }
  return true;
}

export function createPermissionPolicyFromAgentSpec(spec) {
  const rules = [];
  for (const resource of spec?.filesystem?.read ?? []) {
    rules.push({ capability: "read", effect: "allow", resource });
  }
  for (const resource of spec?.filesystem?.write ?? []) {
    rules.push({ capability: "write", effect: "allow", resource });
  }
  for (const resource of spec?.filesystem?.execute ?? []) {
    rules.push({ capability: "execute", effect: "allow", resource });
  }
  for (const scope of spec?.memoryScopes ?? []) {
    if (scope.access === "none") continue;
    if (scope.access === "read" || scope.access === "read-write") {
      rules.push({ capability: "memory", action: "read", effect: "allow", resource: scope.name });
    }
    if (scope.access === "write" || scope.access === "read-write") {
      rules.push({ capability: "memory", action: "write", effect: "allow", resource: scope.name });
    }
  }
  return normalizePermissionPolicy({ rules });
}
