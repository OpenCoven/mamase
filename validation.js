export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function text(value, label, max = 500, optional = false) {
  assert(typeof value === "string", `${label} must be text.`);
  const result = value.trim();
  assert((optional || result.length > 0) && result.length <= max, `${label} must contain ${optional ? "0" : "1"}-${max} characters.`);
  return result;
}

export function number(value, label, min, max, integer = false) {
  assert(typeof value === "number" && Number.isFinite(value), `${label} must be a finite number.`);
  assert(value >= min && value <= max && (!integer || Number.isSafeInteger(value)), `${label} must be ${integer ? "an integer " : ""}between ${min} and ${max}.`);
  return value;
}

export function date(value) {
  assert(typeof value === "string" && Number.isFinite(Date.parse(value)), "A valid timestamp is required.");
  return value;
}

export function id(value) {
  assert(typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value), "Invalid record ID.");
  return value;
}

export function digest(value, label = "File") {
  assert(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), `${label} needs a SHA-256 fingerprint.`);
  return value;
}
