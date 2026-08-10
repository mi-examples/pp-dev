import { loadEnv } from 'vite';

export function loadPPDevEnv(mode = 'development', envDir = process.cwd()): Record<string, string> {
  const env = loadEnv(mode, envDir, 'MI_');

  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }

  return env;
}
