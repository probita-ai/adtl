import { readFile } from "node:fs/promises";
import { parseConfig, type AdtlConfig } from "@adtl/labels";
import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Parse ADTL config from YAML (or JSON, which is valid YAML) text. */
export function parseConfigText(text: string, source = "config"): AdtlConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`${source}: invalid YAML: ${(err as Error).message}`);
  }
  try {
    return parseConfig(raw ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      const problems = err.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
      throw new ConfigError(`${source}: invalid ADTL config\n${problems}`);
    }
    throw err;
  }
}

export async function loadConfigFile(path: string): Promise<AdtlConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new ConfigError(`Cannot read config file ${path}: ${(err as Error).message}`);
  }
  return parseConfigText(text, path);
}
