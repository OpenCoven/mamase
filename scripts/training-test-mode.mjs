import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function trainingTestMode(env = process.env) {
  const python = env.MAMASE_TRAINING_PYTHON || fileURLToPath(new URL("../.venv/bin/python", import.meta.url));
  if (env.MAMASE_REQUIRE_ML === "1" && env.MAMASE_SKIP_ML === "1") {
    throw new Error("Required ML coverage cannot also be explicitly skipped.");
  }
  return {
    python,
    skip: env.MAMASE_REQUIRE_ML === "1" ? false
      : env.MAMASE_SKIP_ML === "1" ? "Explicit Node-only gate; CPU ML runs in its separate required job."
        : !existsSync(python) && "Optional ML not executed. Set MAMASE_TRAINING_PYTHON; use npm run validate -- cpu to require coverage.",
  };
}
