export function divide(a, b) {
  if (typeof a !== "number" || typeof b !== "number" || Number.isNaN(a) || Number.isNaN(b)) {
    throw new TypeError("divide requires two numeric arguments");
  }
  if (b === 0) {
    throw new RangeError("divide: cannot divide by zero");
  }
  return a / b;
}
