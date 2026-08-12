const unsupportedPattern = /\b(?:import|export)\b|import\s*\(/;

export function compileBehavior(source) {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new SyntaxError("The program is empty. Define a function named behave.");
  }

  if (unsupportedPattern.test(source)) {
    throw new SyntaxError("Imports and exports are not available inside an agent rule.");
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
