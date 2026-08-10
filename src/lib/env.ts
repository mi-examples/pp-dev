import { loadEnv } from 'vite';

let previouslyLoadedKeys = new Set<string>();

export function loadPPDevEnv(mode = 'development', envDir = process.cwd()): Record<string, string> {
  // Vite's loadEnv() folds already-set process.env values matching the prefix back into its
  // result, so a previous root's MI_* value would otherwise survive into this load even when
  // envDir's own files don't set it. Clear what we previously wrote before reloading.
  for (const key of previouslyLoadedKeys) {
    delete process.env[key];
  }

  const env = loadEnv(mode, envDir, 'MI_');

  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }

  previouslyLoadedKeys = new Set(Object.keys(env));

  return env;
}
