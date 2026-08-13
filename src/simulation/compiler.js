const unsupportedPattern = /\b(?:import|export)\b|import\s*\(/;
const nondeterministicPatterns = [
  { pattern: /\bMath\s*(?:\.\s*random\b|\[\s*["']random["']\s*\])/, name: "Math.random" },
  { pattern: /\bDate\b/, name: "Date" },
  { pattern: /\bperformance\s*\.\s*now\b/, name: "performance.now" },
  { pattern: /\bcrypto\s*\.\s*getRandomValues\b/, name: "crypto.getRandomValues" },
  { pattern: /\bglobalThis\b/, name: "globalThis" },
];

export function compileBehavior(source) {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new SyntaxError("The program is empty. Define a function named behave.");
  }

  if (unsupportedPattern.test(source)) {
    throw new SyntaxError("Imports and exports are not available inside an agent rule.");
  }

  for (const candidate of nondeterministicPatterns) {
    if (candidate.pattern.test(source)) {
      throw new SyntaxError(`${candidate.name} is not reproducible. Use the provided random(key) helper instead.`);
    }
  }

  let behavior;
  try {
    const factory = new Function(
      `"use strict";\n${source}\n` +
        `if (typeof behave !== "function") {\n` +
        `  throw new TypeError("Define a function named behave.");\n` +
        `}\n` +
        `return behave;\n` +
        `//# sourceURL=student-behavior.js`,
    );
    behavior = factory();
  } catch (error) {
    const wrapped = new SyntaxError(cleanErrorMessage(error));
    wrapped.cause = error;
    throw wrapped;
  }

  return behavior;
}

export function cleanErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Uncaught\s+/, "").replace(/\s+at\s+.*$/s, "").trim();
}
