import { cac } from 'cac';
import { VERSION } from './constants.js';
import { registerServeCommand } from './cli/commands/serve.js';
import { registerNextCommand } from './cli/commands/next.js';
import { registerBuildCommand } from './cli/commands/build.js';
import { registerNextBuildCommand } from './cli/commands/next-build.js';
import { registerChangelogCommand } from './cli/commands/changelog.js';
import { registerGenerateIconFontCommand } from './cli/commands/generate-icon-font.js';
import { registerOptimizeCommand } from './cli/commands/optimize.js';
import { registerPreviewCommand } from './cli/commands/preview.js';
import { registerMigrateCommand } from './cli/commands/migrate.js';
import { applyEnvOption, applyPPConfigOption, lastFlagValue } from './lib/cli-options.js';

export { stopProfiler } from './cli/profiler.js';

const cli = cac('pp-dev');

cli
  .option('-c, --config <file>', `[string] use specified config file`)
  .option('--base <path>', `[string] public base path (default: /)`)
  .option('-l, --logLevel <level>', `[string] info | warn | error | silent`)
  .option('--clearScreen', `[boolean] allow/disable clear screen when logging`)
  .option('-d, --debug [feat]', `[string | boolean] show debug logs`)
  .option('-f, --filter <filter>', `[string] filter debug logs`)
  .option('-m, --mode <mode>', `[string] set env mode`)
  .option('--env <name>', `[string] MI environment from envs in pp-dev.config (sets MI_ENV)`)
  .option('--pp-config <file>', `[string] pp-dev config file to use (default: pp-dev.config.* in the root)`);

registerServeCommand(cli);
registerNextCommand(cli);
registerBuildCommand(cli);
registerNextBuildCommand(cli);
registerChangelogCommand(cli);
registerGenerateIconFontCommand(cli);
registerOptimizeCommand(cli);
registerPreviewCommand(cli);
registerMigrateCommand(cli);

cli.help();
cli.version(VERSION);

cli.parse(process.argv, { run: false });

// From the arguments as typed: cac turns `--env 01` into the number 1, and a repeated flag into an array.
const argv = process.argv.slice(2);

try {
  applyEnvOption(lastFlagValue(argv, ['env']));
  applyPPConfigOption(lastFlagValue(argv, ['pp-config', 'ppConfig']));
} catch (error) {
  console.error(`[pp-dev] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

void cli.runMatchedCommand();
